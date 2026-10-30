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
 * This test drives the real `hz-kernel` (no Guard/EffectHost mock): the batch
 * gate prepares one turn containing two edits to the same file, an edit to a
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

describe("kernel preimage probe", () => {
  test("single-call patch admission", async () => {
    await withLiveHostKernel(({ supervisor, fs, workspace, locationRef }) =>
      Effect.gen(function* () {
        yield* supervisor.registerHostLocation(locationRef)
        yield* supervisor.setDirectSessionPermissionMode({
          sessionID,
          locationRef,
          sandboxMode: "workspace-write",
          approvalPolicy: "never",
          expectedRevision: "1",
        })
        const target = join(workspace, "src", "a.ts")
        mkdirSync(join(workspace, "src"), { recursive: true })
        writeFileSync(target, "export const alpha = 1\n")
        const prepared = yield* prepareEditBatch(
          { filePath: target, oldString: "export const alpha = 1", newString: "export const alpha = 11" },
          workspace,
          fs,
        )
        console.error("PROBE prepared op:", JSON.stringify(prepared.operations))
        const admission = yield* supervisor.prepareToolBatch({
          sessionID,
          locationRef,
          batchID: "batch_probe_one",
          turnContextDigest,
          calls: [{ callID: "call_probe_one", capabilityID: "files.patch", arguments: { operations: prepared.operations } }],
        }).pipe(Effect.provideService(TrustedPrincipalContext, { principal }))
        console.error("PROBE admission:", JSON.stringify(admission))

        const writeOnly = yield* supervisor.prepareToolBatch({
          sessionID,
          locationRef,
          batchID: "batch_probe_two",
          turnContextDigest,
          calls: [{ callID: "call_probe_two", capabilityID: "files.write", arguments: { path: target, content: "hello\n" } }],
        }).pipe(Effect.provideService(TrustedPrincipalContext, { principal }))
        console.error("PROBE write admission:", JSON.stringify(writeOnly))
      }) as unknown as Effect.Effect<void, unknown, never>,
    )
  }, 120_000)
})
