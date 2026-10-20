import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSupervisor, type Interface as SessionSupervisorInterface } from "@opencode-ai/core/session/supervisor"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { location } from "./fixture/location"

const hostKernelRust = resolve(import.meta.dir, "../../../kernel/target/debug/hz-kernel")

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

async function withLiveHostKernel<T>(body: (input: {
  readonly supervisor: SessionSupervisorInterface
  readonly locationRef: typeof Location.Ref.Type
  readonly workspace: string
}) => Effect.Effect<T, unknown>): Promise<T> {
  const state = mkdtempSync(join(tmpdir(), "hc-repo-intel-live-"))
  const root = join(state, "workspace")
  mkdirSync(root)
  const workspace = realpathSync(root)
  writeFileSync(join(workspace, "example.ts"), "export function example(): number { return 1 }\n")
  try {
    const layer = AppNodeBuilder.build(LayerNode.group([SessionSupervisor.node, EventV2.node]), [
      [
        Database.node,
        makeGlobalNode({
          service: Database.Service,
          layer: Database.layerFromPath(join(state, "opencode.db")),
          deps: [],
        }),
      ],
      [Config.node, Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })],
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(workspace) }))),
      ],
      [
        SessionSupervisor.runtimeConfigNode,
        Layer.succeed(SessionSupervisor.RuntimeConfig, SessionSupervisor.RuntimeConfig.of(hostKernelRuntime(state))),
      ],
    ])
    const program = Effect.scoped(
      Effect.gen(function* () {
        const supervisor = yield* SessionSupervisor.Service
        const locationRef = Location.Ref.make({ directory: AbsolutePath.make(workspace) })
        return yield* body({ supervisor, locationRef, workspace })
      }),
    ).pipe(Effect.provide(layer))
    return await Effect.runPromise(program as Effect.Effect<T, unknown, never>)
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
}

test("Core pins RepoIntel generation before querying on the authenticated Session/Location socket", async () => {
  await withLiveHostKernel(({ supervisor, locationRef }) => {
    if (!supervisor.queryRepoStructure) return Effect.die(new Error("Core RepoIntel producer is unavailable"))
    return supervisor
      .queryRepoStructure({
        sessionID: "ses_repo_intel_live",
        locationRef,
        query: {
          schemaVersion: 1,
          messageType: "query",
          queryId: "query_repo_intel_live",
          rootRef: ".",
          selector: { symbols: ["example"] },
          maxNodes: 32,
          maxBytes: 32_768,
          maxDepth: 8,
          deadline: new Date(Date.now() + 20_000).toISOString(),
        },
      })
      .pipe(
        Effect.provideService(TrustedPrincipalContext, {
          principal: { kind: "server_auth", subject: "repo-intel-reviewer" },
        }),
        Effect.tap((page) =>
          Effect.sync(() => {
            expect(page.queryId).toBe("query_repo_intel_live")
            expect(page.workspaceBinding).toBeTruthy()
            expect(page.sourceGeneration).toMatch(/^blake3:[0-9a-f]{64}$/)
            expect(page.sourceRevision).toMatch(/^blake3:[0-9a-f]{64}$/)
            expect(page.status).not.toBe("STALE")
            expect(page.freshness).not.toBe("stale")
            expect(page.nodes.every((node) => node.workspaceBinding === page.workspaceBinding)).toBe(true)
            expect(page.nodes.every((node) => node.sourceGeneration === page.sourceGeneration)).toBe(true)
          }),
        ),
      )
  })
})
