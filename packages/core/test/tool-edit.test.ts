import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { EditTool } from "@opencode-ai/core/tool/edit"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_edit_tool_test")
const assertions: PermissionV2.AssertInput[] = []
const writes: string[] = []
let reads = 0
let denyAction: string | undefined
let afterRead = (_target: string, _content: Uint8Array): Effect.Effect<void> => Effect.void

/**
 * `edit` mutates files through `FileMutation`, which carries no Guard challenge and no
 * lease redemption; only the first-party `write` leaf binds a challenge to its target and
 * redeems it in Rust (`packages/core/src/tool/write.ts`). The canonical registry therefore
 * withholds `edit` from advertisement and refuses settlement before this leaf runs
 * (`packages/core/src/tool/registry.ts` — unclassified registrations are deleted from
 * materialization, so settlement answers `Unknown tool: edit`). These tests pin that
 * fail-closed posture: no advertisement, no permission prompt, no read, no write.
 */
const WITHHELD = { type: "error", value: "Unknown tool: edit" } as const

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(
          input.action === denyAction ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    policySnapshotDigest: () => Effect.succeed(`sha256:${"0".repeat(64)}`),
  }),
)

const reset = () => {
  assertions.length = 0
  writes.length = 0
  reads = 0
  denyAction = undefined
  afterRead = () => Effect.void
}

const filesystem = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...fs,
      readFile: (target) =>
        fs
          .readFile(target)
          .pipe(
            Effect.tap((content) =>
              Effect.sync(() => reads++).pipe(Effect.andThen(Effect.suspend(() => afterRead(target, content)))),
            ),
          ),
      writeWithDirs: (target, content, mode) =>
        Effect.sync(() => writes.push(target)).pipe(Effect.andThen(fs.writeWithDirs(target, content, mode))),
      writeFile: (target, content, options) =>
        Effect.sync(() => writes.push(target)).pipe(Effect.andThen(fs.writeFile(target, content, options))),
      writeFileString: (target, content, options) =>
        Effect.sync(() => writes.push(target)).pipe(Effect.andThen(fs.writeFileString(target, content, options))),
    })
  }),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

const withTool = <A, E, R>(directory: string, body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          LocationMutation.node,
          FileMutation.node,
          EditTool.node,
        ]),
        [
          [FSUtil.node, filesystem],
          [Location.node, activeLocation],
          [PermissionV2.node, permission],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const call = (input: typeof EditTool.Input.Type, id = "call-edit") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "edit", input },
})

const it = testEffect(Layer.empty)

describe("EditTool", () => {
  it.live("withholds edit from advertisement and refuses settlement before any filesystem access", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "hello.txt")
        return Effect.promise(() => fs.writeFile(target, "before\nrest\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(EditTool.name).toBe("edit")
                expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([])
                expect(yield* toolDefinitions(registry, [{ action: "*", resource: "*", effect: "allow" }])).toEqual([])
                expect(yield* toolDefinitions(registry, [{ action: "edit", resource: "*", effect: "deny" }])).toEqual(
                  [],
                )
                const settled = yield* settleTool(
                  registry,
                  call({ path: "hello.txt", oldString: "before", newString: "after" }),
                )
                expect(settled).toEqual({ result: WITHHELD })
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("before\nrest\n")
                expect(assertions).toEqual([])
                expect(reads).toBe(0)
                expect(writes).toEqual([])
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("refuses an absolute in-Location path without reading or writing", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "absolute.txt")
        return Effect.promise(() => fs.writeFile(target, "before")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              executeTool(registry, call({ path: target, oldString: "before", newString: "after" })),
            ),
          ),
          Effect.andThen((result) =>
            Effect.gen(function* () {
              expect(result).toEqual(WITHHELD)
              expect(assertions).toEqual([])
              expect(reads).toBe(0)
              expect(writes).toEqual([])
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("before")
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("refuses an external absolute path without requesting external_directory approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        const target = path.join(outside.path, "external.txt")
        return Effect.promise(() => fs.writeFile(target, "before")).pipe(
          Effect.andThen(
            withTool(active.path, (registry) =>
              executeTool(registry, call({ path: target, oldString: "before", newString: "after" })),
            ),
          ),
          Effect.andThen((result) =>
            Effect.gen(function* () {
              expect(result).toEqual(WITHHELD)
              expect(assertions).toEqual([])
              expect(reads).toBe(0)
              expect(writes).toEqual([])
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("before")
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("refuses without prompting even when policy would deny external_directory or edit", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          const external = path.join(outside.path, "denied.txt")
          yield* Effect.promise(() => fs.writeFile(external, "before"))
          reset()
          denyAction = "external_directory"
          expect(
            yield* withTool(active.path, (registry) =>
              executeTool(registry, call({ path: external, oldString: "before", newString: "after" })),
            ),
          ).toEqual(WITHHELD)
          expect(assertions).toEqual([])
          expect(reads).toBe(0)
          expect(writes).toEqual([])

          reset()
          denyAction = "edit"
          expect(
            yield* withTool(active.path, (registry) =>
              executeTool(registry, call({ path: external, oldString: "before", newString: "after" })),
            ),
          ).toEqual(WITHHELD)
          expect(assertions).toEqual([])
          expect(reads).toBe(0)
          expect(writes).toEqual([])
          expect(yield* Effect.promise(() => fs.readFile(external, "utf8"))).toBe("before")
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("refuses identically whether or not oldString matches, so no target content is disclosed", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        denyAction = "edit"
        const target = path.join(tmp.path, "secret.txt")
        return Effect.promise(() => fs.writeFile(target, "secret content")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                const matching = yield* executeTool(
                  registry,
                  call({ path: "secret.txt", oldString: "secret content", newString: "replacement" }),
                )
                const missing = yield* executeTool(
                  registry,
                  call({ path: "secret.txt", oldString: "not present", newString: "replacement" }),
                )

                expect(matching).toEqual(WITHHELD)
                expect(missing).toEqual(matching)
                expect(assertions).toEqual([])
                expect(reads).toBe(0)
                expect(writes).toEqual([])
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("secret content")
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("refuses no-op, empty, missing, and ambiguous replacements identically without touching the file", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "matches.txt")
        return Effect.promise(() => fs.writeFile(target, "same same")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                const inputs: Array<typeof EditTool.Input.Type> = [
                  { path: "matches.txt", oldString: "same", newString: "same" },
                  { path: "matches.txt", oldString: "", newString: "after" },
                  { path: "matches.txt", oldString: "missing", newString: "after" },
                  { path: "matches.txt", oldString: "same", newString: "after" },
                ]
                for (const input of inputs) expect(yield* executeTool(registry, call(input))).toEqual(WITHHELD)
                expect(assertions).toEqual([])
                expect(reads).toBe(0)
                expect(writes).toEqual([])
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("same same")
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("refuses replaceAll requests without mutating the file", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "all.txt")
        return Effect.promise(() => fs.writeFile(target, "same same same")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              settleTool(registry, call({ path: "all.txt", oldString: "same", newString: "after", replaceAll: true })),
            ),
          ),
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              expect(settled).toEqual({ result: WITHHELD })
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("same same same")
              expect(assertions).toEqual([])
              expect(reads).toBe(0)
              expect(writes).toEqual([])
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("refuses BOM and CRLF edits without touching the file", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "windows.txt")
        return Effect.promise(() => fs.writeFile(target, "\uFEFFbefore\r\nrest\r\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              executeTool(registry, call({ path: "windows.txt", oldString: "before\nrest", newString: "after\nrest" })),
            ),
          ),
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result).toEqual(WITHHELD)
              expect(reads).toBe(0)
              expect(writes).toEqual([])
            }),
          ),
          Effect.andThen(() => Effect.promise(() => fs.readFile(target, "utf8"))),
          Effect.tap((content) =>
            Effect.sync(() => expect(content).toBe("\uFEFFbefore\r\nrest\r\n")),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("refuses the concurrent-change case without reading, so no stale-content commit is possible", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "concurrent.txt")
        afterRead = () => (reads === 1 ? Effect.promise(() => fs.writeFile(target, "newer\n")) : Effect.void)
        return Effect.promise(() => fs.writeFile(target, "before\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              executeTool(registry, call({ path: "concurrent.txt", oldString: "before", newString: "after" })),
            ),
          ),
          Effect.andThen((result) =>
            Effect.gen(function* () {
              expect(result).toEqual(WITHHELD)
              expect(reads).toBe(0)
              expect(writes).toEqual([])
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("before\n")
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

test("keeps the locked edit schema, semantics docstring, and deferred TODOs visible while edit is withheld", async () => {
  const source = (await fs.readFile(new URL("../src/tool/edit.ts", import.meta.url), "utf8")).replaceAll("\r\n", "\n")
  const schema = Schema.toJsonSchemaDocument(EditTool.Input).schema as {
    readonly properties?: Record<string, unknown>
  }

  expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["newString", "oldString", "path", "replaceAll"])
  const definitions = await Effect.runPromise(
    withTool(path.dirname(fileURLToPath(import.meta.url)), (registry) => toolDefinitions(registry)),
  )
  expect(definitions).toEqual([])
  expect(source).toContain(
    "absolute external paths retain mutation capability through a separate\n * external_directory approval before edit approval.",
  )
  for (const todo of [
    "Port V1 fuzzy correction strategies only after exact-edit behavior is established: line-trimmed matching, block-anchor fallback, indentation correction, and similarity-threshold review.",
    "Add formatter integration after V2 formatter runtime exists.",
    "Publish watcher/file-edit events after V2 watcher integration exists.",
    "Add snapshots / undo after design exists.",
    "Add LSP notification and diagnostics after V2 LSP runtime exists.",
  ]) {
    expect(source).toContain(`TODO: ${todo}`)
  }
})
