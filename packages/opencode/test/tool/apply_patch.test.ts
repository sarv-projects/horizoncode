import { describe, expect } from "bun:test"
import path from "path"
import * as fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionSupervisor } from "@opencode-ai/core/session/supervisor"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import { ApplyPatchTool, preparePatchBatch } from "../../src/tool/apply_patch"
import { LSP } from "@/lsp/lsp"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { TestInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const supervisor = LayerNode.make({
  service: SessionSupervisor.Service,
  layer: Layer.succeed(
    SessionSupervisor.Service,
    SessionSupervisor.Service.of({
      open: () => Effect.die("unexpected supervisor open"),
      openForSession: () => Effect.die("unexpected supervisor open"),
      registerHostLocation: () => Effect.die("unexpected host location registration"),
      prepareUserEffect: () => Effect.die("unexpected user effect preparation"),
      replyGuardApproval: () => Effect.die("unexpected guard approval reply"),
      awaitManagedVerifierApprovals: () => Effect.die("unexpected managed verifier approval"),
      prepareToolBatch: () => Effect.die("unexpected effect preparation"),
      executeWrite: () => Effect.die("unexpected effect execution"),
      executePatch: () => Effect.die("unexpected patch execution"),
      runPatch: () => Effect.die("unexpected patch execution"),
      requestHostKernel: () => Effect.die("unexpected host kernel request"),
      hostOwnerEpoch: () => Effect.die("unexpected host owner epoch read"),
      subscribeHostKernelEvents: () => Stream.die("unexpected host kernel event subscription"),
      watchSession: () => Effect.die("unexpected session watch"),
    }),
  ),
  deps: [],
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([LSP.node, FSUtil.node, Format.node, EventV2Bridge.node, Truncate.node, Agent.node, supervisor]),
  ),
)

const baseCtx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  extra: {},
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const execute = Effect.fn("ApplyPatchToolTest.execute")(function* (patchText: string, ctx: Tool.Context = baseCtx) {
  const info = yield* ApplyPatchTool
  const tool = yield* info.init()
  return yield* tool.execute({ patchText }, ctx)
})

type PreparedPatch = { operations: PreparedOperation[] }

const prepare = (patchText: string): Effect.Effect<PreparedPatch, unknown, TestInstance | FSUtil.Service> =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const fs = yield* FSUtil.Service
    return yield* preparePatchBatch(patchText, instance.directory, fs)
  })

const writeText = (filepath: string, content: string) => Effect.promise(() => fs.writeFile(filepath, content, "utf-8"))
const readText = (filepath: string) => Effect.promise(() => fs.readFile(filepath, "utf-8"))
const makeDir = (dir: string) => Effect.promise(() => fs.mkdir(dir, { recursive: true }))

const expectFailure = <A, E, R>(effect: Effect.Effect<A, E, R>, message?: string) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && message) expect(Cause.pretty(exit.cause)).toContain(message)
  })

type PreparedOperation = {
  operation: "write" | "delete"
  path: string
  expectedBeforeBase64: string | null
  contentBase64?: string
}

const writeOperation = (operations: ReadonlyArray<PreparedOperation>, filepath: string) => {
  const operation = operations.find((item) => item.operation === "write" && item.path === filepath)
  if (!operation || typeof operation.contentBase64 !== "string") {
    throw new Error(`Missing write operation for ${filepath}`)
  }
  return {
    ...operation,
    content: Buffer.from(operation.contentBase64, "base64").toString("utf8"),
  }
}

const deleteOperation = (operations: ReadonlyArray<PreparedOperation>, filepath: string) => {
  const operation = operations.find((item) => item.operation === "delete" && item.path === filepath)
  if (!operation) throw new Error(`Missing delete operation for ${filepath}`)
  return operation
}

describe("tool.apply_patch Guard preparation", () => {
  it.instance(
    "prepares add, update and delete operations with exact preimages",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const added = path.join(instance.directory, "nested", "new.txt")
      const deleted = path.join(instance.directory, "delete.txt")
      const updated = path.join(instance.directory, "modify.txt")
      yield* writeText(deleted, "obsolete\n")
      yield* writeText(updated, "line1\nline2\n")

      const patch =
        "*** Begin Patch\n*** Add File: nested/new.txt\n+created\n*** Delete File: delete.txt\n*** Update File: modify.txt\n@@\n-line2\n+changed\n*** End Patch"
      const result = yield* prepare(patch)

      expect(writeOperation(result.operations, added)).toMatchObject({
        expectedBeforeBase64: null,
        content: "created\n",
      })
      expect(deleteOperation(result.operations, deleted).expectedBeforeBase64).toBe(
        Buffer.from("obsolete\n").toString("base64"),
      )
      expect(writeOperation(result.operations, updated)).toMatchObject({
        expectedBeforeBase64: Buffer.from("line1\nline2\n").toString("base64"),
        content: "line1\nchanged\n",
      })
      expect(yield* readText(updated)).toBe("line1\nline2\n")
      expect(yield* readText(deleted)).toBe("obsolete\n")
      expect(
        yield* Effect.promise(() =>
          fs
            .stat(added)
            .then(() => true)
            .catch(() => false),
        ),
      ).toBe(false)
    }),
    { git: true },
  )

  it.instance(
    "prepares a move as an exact source delete and destination create",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const original = path.join(instance.directory, "old", "name.txt")
      const moved = path.join(instance.directory, "renamed", "dir", "name.txt")
      yield* makeDir(path.dirname(original))
      yield* writeText(original, "old content\n")

      const patch =
        "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-old content\n+new content\n*** End Patch"
      const result = yield* prepare(patch)

      expect(deleteOperation(result.operations, original).expectedBeforeBase64).toBe(
        Buffer.from("old content\n").toString("base64"),
      )
      expect(writeOperation(result.operations, moved)).toMatchObject({
        expectedBeforeBase64: null,
        content: "new content\n",
      })
      expect(yield* readText(original)).toBe("old content\n")
    }),
    { git: true },
  )

  it.instance(
    "preserves file BOM while deriving update content",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const bom = String.fromCharCode(0xfeff)
        const target = path.join(instance.directory, "example.cs")
        yield* writeText(target, `${bom}using System;\n\nclass Test {}\n`)

        const patch = "*** Begin Patch\n*** Update File: example.cs\n@@\n class Test {}\n+class Next {}\n*** End Patch"
        const result = yield* prepare(patch)
        const update = writeOperation(result.operations, target)
        expect(update.content.charCodeAt(0)).toBe(0xfeff)
        expect(update.content.slice(1)).toBe("using System;\n\nclass Test {}\nclass Next {}\n")
      }),
    { git: true },
  )

  it.instance(
    "applies multiple hunks to the prepared contents",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const target = path.join(instance.directory, "multi.txt")
        yield* writeText(target, "line1\nline2\nline3\nline4\n")

        const patch =
          "*** Begin Patch\n*** Update File: multi.txt\n@@\n-line2\n+changed2\n@@\n-line4\n+changed4\n*** End Patch"
        const result = yield* prepare(patch)
        expect(writeOperation(result.operations, target).content).toBe("line1\nchanged2\nline3\nchanged4\n")
        expect(yield* readText(target)).toBe("line1\nline2\nline3\nline4\n")
      }),
    { git: true },
  )

  it.instance(
    "supports insert-only hunks and end-of-file anchors",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const insertTarget = path.join(instance.directory, "insert.txt")
        const eofTarget = path.join(instance.directory, "tail.txt")
        yield* writeText(insertTarget, "alpha\nomega\n")
        yield* writeText(eofTarget, "alpha\nlast\n")

        const insert = yield* prepare(
          "*** Begin Patch\n*** Update File: insert.txt\n@@\n alpha\n+beta\n omega\n*** End Patch",
        )
        const eof = yield* prepare(
          "*** Begin Patch\n*** Update File: tail.txt\n@@\n-last\n+end\n*** End of File\n*** End Patch",
        )
        expect(writeOperation(insert.operations, insertTarget).content).toBe("alpha\nbeta\nomega\n")
        expect(writeOperation(eof.operations, eofTarget).content).toBe("alpha\nend\n")
      }),
    { git: true },
  )

  it.instance(
    "preserves trailing and leading whitespace outside changed hunks",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const target = path.join(instance.directory, "whitespace.txt")
        yield* writeText(target, "  line1  \nline2\n  line3   \n")

        const result = yield* prepare(
          "*** Begin Patch\n*** Update File: whitespace.txt\n@@\n-line2\n+changed\n*** End Patch",
        )
        expect(writeOperation(result.operations, target).content).toBe("  line1  \nchanged\n  line3   \n")
      }),
    { git: true },
  )

  it.instance(
    "parses heredoc-wrapped patch input",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const patch = `cat <<'EOF'\n*** Begin Patch\n*** Add File: heredoc.txt\n+heredoc content\n*** End Patch\nEOF`
        const result = yield* prepare(patch)
        expect(writeOperation(result.operations, path.join(instance.directory, "heredoc.txt")).content).toBe(
          "heredoc content\n",
        )
      }),
    { git: true },
  )

  it.instance(
    "rejects invalid patches, missing files and paths outside the workspace",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const missingUpdate = "*** Begin Patch\n*** Update File: missing.txt\n@@\n-nope\n+better\n*** End Patch"
        const missingDelete = "*** Begin Patch\n*** Delete File: missing.txt\n*** End Patch"
        const outside = "*** Begin Patch\n*** Add File: ../escape.txt\n+nope\n*** End Patch"
        const empty = yield* prepare("*** Begin Patch\n*** End Patch")

        yield* expectFailure(prepare("not a patch"))
        expect(empty.operations).toEqual([])
        yield* expectFailure(prepare(missingUpdate))
        yield* expectFailure(prepare(missingDelete))
        yield* expectFailure(prepare(outside), "path escapes the workspace")

        const invalidMoveSource = path.join(instance.directory, "move-source.txt")
        yield* writeText(invalidMoveSource, "source\n")
        yield* expectFailure(
          prepare(
            "*** Begin Patch\n*** Update File: move-source.txt\n*** Move to: ../escape.txt\n@@\n-source\n+target\n*** End Patch",
          ),
          "move path escapes the workspace",
        )
        expect(
          yield* Effect.promise(() =>
            fs
              .stat(path.join(instance.directory, "escape.txt"))
              .then(() => true)
              .catch(() => false),
          ),
        ).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "rejects an unbound tool patch before permission or mutation",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const target = path.join(instance.directory, "guarded.txt")
        yield* writeText(target, "unchanged\n")
        let asks = 0
        const ctx: Tool.Context = {
          ...baseCtx,
          ask: () => Effect.sync(() => asks++).pipe(Effect.asVoid),
        }

        yield* expectFailure(
          execute("*** Begin Patch\n*** Update File: guarded.txt\n@@\n-unchanged\n+changed\n*** End Patch", ctx),
          "Patch denied: guarded operation set or lease changed",
        )
        expect(asks).toBe(0)
        expect(yield* readText(target)).toBe("unchanged\n")
      }),
    { git: true },
  )
})
