import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@horizoncode/core/effect/app-node-builder"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { makeGlobalNode } from "@horizoncode/core/effect/app-node"
import { Database } from "@horizoncode/core/database/database"
import { Config } from "@horizoncode/core/config"
import { Location } from "@horizoncode/core/location"
import { Project } from "@horizoncode/core/project"
import { FSUtil } from "@horizoncode/core/fs-util"
import { AbsolutePath } from "@horizoncode/core/schema"
import { SessionSupervisor, type EffectLease, type PatchOperation } from "@horizoncode/core/session/supervisor"
import { TrustedPrincipalContext } from "@horizoncode/core/trusted-principal"
import {
  createToolBatchContext,
  gateToolCallStream,
  resolveToolBatchLease,
  settleToolBatchLease,
  toolBatchMemberChain,
  toolCallOutcome,
  type ToolBatchContext,
  type ToolBatchDefinition,
  type ToolBatchGateInput,
} from "../../src/session/tool-batch"
import { editToolBatchAdmission } from "../../src/session/tool-admission"
import { Parameters as EditParametersSchema, prepareEditBatch } from "../../src/tool/edit"
import { isRecord } from "../../src/util/record"

/**
 * A direct turn whose batch contains more than one mutation is the shape that
 * failed 22 times in the 29-minute live run: every one of the 11 assistant
 * messages that emitted two or more `edit` calls lost every call to
 * "Edit denied: guarded operation set or lease changed", while all 34 messages
 * that emitted exactly one edit succeeded.
 *
 * This test drives the real `hz-kernel` (no Guard/EffectHost mock). Rebuild
 * `kernel/target/debug/hz-kernel` after Rust EffectHost changes before running.
 * The batch gate prepares one turn containing two edits to the same file, an edit to a
 * second file, an interleaved `write`, and a `read`, and then executes the exact
 * `files.patch` effects the `edit` tool executes. It asserts both halves that
 * matter: no member is denied, and the resulting file content is exactly the
 * sequence of edits the model asked for (a lease fix that let stale operations
 * through would corrupt the file and is not a fix).
 */

const hostKernelCandidates = [
  ...(process.env.HZ_KERNEL_BIN ? [process.env.HZ_KERNEL_BIN] : []),
  resolve(import.meta.dir, "../../../../kernel/target/debug/hz-kernel"),
  resolve(import.meta.dir, "../../../../target-p2/debug/hz-kernel"),
]
const hostKernelRust = hostKernelCandidates.find((candidate) => existsSync(candidate)) ?? hostKernelCandidates[0]!
const sessionID = "ses_edit_batch_live"
const turnContextDigest = `sha256:${"c".repeat(64)}`
const principal = { kind: "server_auth", subject: "edit-batch-live" } as const

function hostKernelRuntime(stateDirectory: string) {
  expect(existsSync(hostKernelRust)).toBe(true)
  return {
    hostKernelAssetPath: hostKernelRust,
    hostKernelManifestJSON: JSON.stringify({
      schemaVersion: 1,
      status: "available",
      binaryName: "hz-kernel",
      target: `linux-${process.arch}-gnu`,
      sha256: createHash("sha256").update(readFileSync(hostKernelRust)).digest("hex"),
    }),
    hostKernelInstallRoot: join(stateDirectory, "host-kernel-install"),
    hostKernelStateRoot: join(stateDirectory, "host-kernel-state"),
    installRoot: join(stateDirectory, "session-observer-install"),
    stateRoot: join(stateDirectory, "session-observer-state"),
  }
}

const finish = {
  type: "finish",
  finishReason: { unified: "tool-calls", raw: "tool-calls" },
  usage: {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  },
} satisfies LanguageModelV3StreamPart

function toolCall(toolCallId: string, toolName: string, input: unknown): LanguageModelV3StreamPart {
  return { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) }
}

function stream(parts: LanguageModelV3StreamPart[]) {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    },
  })
}

async function collect(source: ReadableStream<LanguageModelV3StreamPart>) {
  const parts: LanguageModelV3StreamPart[] = []
  const reader = source.getReader()
  while (true) {
    const next = await reader.read()
    if (next.done) return parts
    parts.push(next.value)
  }
}

const readDefinition: ToolBatchDefinition = {
  capability: { id: "files.read", effectClass: "read_only" },
  schema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
  validate: async (value) => {
    if (!isRecord(value) || typeof value.filePath !== "string") throw new Error("invalid read")
    return value
  },
}

const writeDefinition: ToolBatchDefinition = {
  capability: { id: "files.write", effectClass: "effect" },
  schema: {
    type: "object",
    properties: { filePath: { type: "string" }, content: { type: "string" } },
    required: ["filePath", "content"],
  },
  validate: async (value) => {
    if (!isRecord(value) || typeof value.filePath !== "string" || typeof value.content !== "string")
      throw new Error("invalid write")
    return value
  },
  normalize: (value) => {
    if (!isRecord(value) || typeof value.filePath !== "string" || typeof value.content !== "string")
      throw new Error("invalid write")
    return { path: value.filePath as string, content: value.content as string }
  },
}

/** One live HostKernel + one registered Location + one workspace per case. */
async function withLiveHostKernel<T>(body: (context: {
  readonly supervisor: import("@horizoncode/core/session/supervisor").Interface
  readonly fs: FSUtil.Interface
  readonly workspace: string
  readonly locationRef: ReturnType<typeof Location.Ref.make>
}) => Effect.Effect<T, unknown, never>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "hc-edit-batch-live-"))
  const workspacePath = join(dir, "workspace")
  mkdirSync(workspacePath)
  const workspace = realpathSync(workspacePath)
  try {
    const layer = AppNodeBuilder.build(LayerNode.group([SessionSupervisor.node, FSUtil.node]), [
      [
        Database.node,
        makeGlobalNode({ service: Database.Service, layer: Database.layerFromPath(join(dir, "opencode.db")), deps: [] }),
      ],
      [Config.node, Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })],
      [
        Location.node,
        Layer.succeed(
          Location.Service,
          Location.Service.of({
            directory: AbsolutePath.make(workspace),
            workspaceID: undefined,
            project: { id: Project.ID.global, directory: AbsolutePath.make(workspace) },
            vcs: undefined,
          } satisfies Location.Interface),
        ),
      ],
      [
        SessionSupervisor.runtimeConfigNode,
        Layer.succeed(SessionSupervisor.RuntimeConfig, SessionSupervisor.RuntimeConfig.of(hostKernelRuntime(dir))),
      ],
    ])
    const program = Effect.scoped(
      Effect.gen(function* () {
        const supervisor = yield* SessionSupervisor.Service
        const fs = yield* FSUtil.Service
        const locationRef = Location.Ref.make({ directory: AbsolutePath.make(workspace) })
        return yield* body({ supervisor, fs, workspace, locationRef })
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.provideService(TrustedPrincipalContext, { principal }),
    )
    return await Effect.runPromise(program as Effect.Effect<T, unknown, never>)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("direct turn with several mutations in one batch", () => {
  test("two same-file edits, a second file edit, a write and a read all reach their effect", async () => {
    await withLiveHostKernel(({ supervisor, fs, workspace, locationRef }) =>
      Effect.gen(function* () {
        yield* supervisor.registerHostLocation(locationRef)
        // `workspace-write` + `never` is the mode that makes HostKernel classify a
        // patch batch as a mode-approval candidate: it answers `admitted_batch`
        // with one one-use lease per member and no user approval round. That is
        // exactly the live run's shape, and the shape that used to lose every
        // member's lease inside the Core batch gate.
        yield* supervisor.setDirectSessionPermissionMode({
          sessionID,
          locationRef,
          sandboxMode: "workspace-write",
          approvalPolicy: "never",
          expectedRevision: "1",
        })

        const first = join(workspace, "src", "index.ts")
        const second = join(workspace, "src", "meter.ts")
        mkdirSync(join(workspace, "src"), { recursive: true })
        writeFileSync(first, "export const alpha = 1\nexport const beta = 2\nexport const gamma = 3\n")
        writeFileSync(second, "export const rate = 10\n")

        const admission = editToolBatchAdmission({
          directory: workspace,
          fs,
          promise: (effect) => Effect.runPromise(effect),
        })
        const definitions: Record<string, ToolBatchDefinition> = {
          edit: {
            capability: { id: "files.patch", effectClass: "effect" },
            schema: EditParametersSchema,
            validate: admission.validate,
            prepare: admission.prepare,
          },
          write: writeDefinition,
          read: readDefinition,
        }

        const context: ToolBatchContext = createToolBatchContext()
        const gateInput: ToolBatchGateInput = {
          sessionID,
          locationRef,
          turnContextDigest,
          signal: new AbortController().signal,
          definitions,
          prepareToolBatch: (request) =>
            Effect.runPromise(
              supervisor
                .prepareToolBatch(request)
                .pipe(Effect.provideService(TrustedPrincipalContext, { principal })),
            ),
          cancelToolBatch: async () => {},
          context,
        } as ToolBatchGateInput

        const parts = [
          toolCall("call_edit_a1", "edit", {
            filePath: first,
            oldString: "export const alpha = 1",
            newString: "export const alpha = 11",
          }),
          toolCall("call_edit_a2", "edit", {
            filePath: first,
            oldString: "export const gamma = 3",
            newString: "export const gamma = 33",
          }),
          toolCall("call_edit_b1", "edit", {
            filePath: second,
            oldString: "export const rate = 10",
            newString: "export const rate = 20",
          }),
          toolCall("call_write_c", "write", {
            filePath: join(workspace, "src", "created.ts"),
            content: "export const created = true\n",
          }),
          toolCall("call_read_a", "read", { filePath: first }),
          finish,
        ]
        yield* Effect.promise(() => collect(gateToolCallStream(stream(parts), gateInput)))

        // 1. No member may be admitted without the host lease it needs. A challenge
        //    only outcome is the exact defect: it reaches the tool as a missing
        //    `guardedLease` and becomes "Edit denied: guarded operation set or
        //    lease changed" before Guard is ever consulted.
        const chain = ["call_edit_a1", "call_edit_a2", "call_edit_b1", "call_write_c"]
        const leases = new Map<string, EffectLease>()
        for (const callID of chain) {
          const outcome = toolCallOutcome(context, callID)
          expect({ callID, status: outcome?.status }).toEqual({ callID, status: "prepared" })
          if (outcome?.status !== "prepared") throw new Error("no prepared outcome for " + callID)
          const lease = outcome.lease as EffectLease
          expect(lease.capabilityLeaseDigest).toMatch(/^blake3:[0-9a-f]{64}$/)
          leases.set(callID, lease)
        }
        // The read member stays a local read-only call and must not be forced
        // through Guard.
        expect(toolCallOutcome(context, "call_read_a")).toEqual({
          status: "allowed",
          capabilityID: "files.read",
        })

        // 2. Same-file members must be ordered: the second edit's approved
        //    preimage is the first edit's output, so it may only run afterwards.
        const secondMember = toolBatchMemberChain("call_edit_a2")
        expect(secondMember?.predecessor).toBeDefined()
        expect(toolBatchMemberChain("call_edit_a1")?.predecessor).toBeUndefined()
        expect(toolBatchMemberChain("call_edit_b1")?.predecessor).toBeUndefined()

        // 3. Execute the exact effects the tools execute, in prepared order,
        //    reconciling each against a fresh prepare the way `edit` does.
        for (const callID of chain) {
          const outcome = toolCallOutcome(context, callID)
          if (outcome?.status !== "prepared") throw new Error("no prepared outcome for " + callID)
          const chainLink = toolBatchMemberChain(callID)
          if (chainLink?.predecessor) yield* Effect.promise(() => chainLink.predecessor!)
          const resolvedLease = yield* Effect.promise(() => resolveToolBatchLease(outcome.lease))
          if (callID.startsWith("call_edit")) {
            const operations = outcome.execution as ReadonlyArray<PatchOperation>
            const call = parts.find((part) => part.type === "tool-call" && part.toolCallId === callID)
            if (!call || call.type !== "tool-call") throw new Error("missing call " + callID)
            const args = JSON.parse(call.input as string)
            const prepared = yield* prepareEditBatch(args, workspace, fs)
            expect(prepared.operations).toEqual(operations as never)
            const receipt = yield* supervisor.executePatch({
              sessionID,
              locationRef,
              lease: resolvedLease,
              operations,
              trustedPrincipal: principal,
            })
            expect(receipt.effectID).toBe(resolvedLease.effectID)
            expect(receipt.targets.length).toBe(operations.length)
            yield* Effect.promise(() => settleToolBatchLease(outcome.lease, { effectID: receipt.effectID }))
          } else if (callID === "call_write_c") {
            const call = parts.find((part) => part.type === "tool-call" && part.toolCallId === callID)
            if (!call || call.type !== "tool-call") throw new Error("missing call " + callID)
            const args = JSON.parse(call.input as string) as { filePath: string; content: string }
            const receipt = yield* supervisor.executeWrite({
              sessionID,
              locationRef,
              lease: resolvedLease,
              content: args.content,
              trustedPrincipal: principal,
            })
            expect(receipt.effectID).toBe(resolvedLease.effectID)
            yield* Effect.promise(() => settleToolBatchLease(outcome.lease, { effectID: receipt.effectID }))
          } else {
            throw new Error("unexpected chain member " + callID)
          }
          chainLink?.settle()
        }

        // 4. Correct final content: the sequence applied exactly, no lost update.
        expect(readFileSync(first, "utf8")).toBe(
          "export const alpha = 11\nexport const beta = 2\nexport const gamma = 33\n",
        )
        expect(readFileSync(second, "utf8")).toBe("export const rate = 20\n")
        expect(readFileSync(join(workspace, "src", "created.ts"), "utf8")).toBe("export const created = true\n")
      }) as Effect.Effect<void, unknown, never>,
    )
  }, 120_000)
})
