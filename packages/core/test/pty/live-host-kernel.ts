// Live Core -> Rust PTY harness. Each case boots a private host-kernel binary and
// assembles the same Core graph the app uses (`SessionSupervisor.node` + `Pty.node`),
// so `terminal.start`, Guard approval, streaming and cancellation all run through the
// real canonical Guard/ExecutionHost path instead of mocks.
//
// Mirrors `packages/core/test/terminal-run-live.test.ts`: the host kernel is packaged
// like `packages/opencode/script/build.ts` and the default Guard approval answer is
// `allow_once` unless a case supplies a different decision.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { test } from "bun:test"
import { Cause, Effect, Exit, Layer, Queue } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Database } from "@opencode-ai/core/database/database"
import { Config } from "@opencode-ai/core/config"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Pty } from "@opencode-ai/core/pty"
import { AbsolutePath } from "@opencode-ai/core/schema"
import {
  GuardApprovalRequested,
  SessionSupervisor,
  type GuardApprovalRequest,
  type Interface as SessionSupervisorInterface,
} from "@opencode-ai/core/session/supervisor"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { location } from "../fixture/location"

const hostKernelRust = resolve(import.meta.dir, "../../../../kernel/target/debug/hz-kernel")

export const liveHostKernelAvailable = process.platform === "linux" && existsSync(hostKernelRust)

// PTY-006: native Windows ConPTY stays unavailable on this platform; the harness is
// Linux-only and must not pretend to cover the Windows backend.
export const ptyLiveTest = process.platform === "win32" ? test.skip : test

export const livePrincipal = { kind: "server_auth", subject: "pty-live-test" } as const

function hostKernelRuntime(stateDirectory: string) {
  return {
    hostKernelAssetPath: hostKernelRust,
    hostKernelManifestJSON: JSON.stringify({
      schemaVersion: 1,
      status: "available",
      binaryName: "hz-kernel",
      target: `linux-${process.arch}-gnu`,
      sha256: createHash("sha256").update(readFileSync(hostKernelRust)).digest("hex"),
    }),
    hostKernelInstallRoot: join(stateDirectory, "hi"),
    hostKernelStateRoot: join(stateDirectory, "hs"),
    installRoot: join(stateDirectory, "oi"),
    stateRoot: join(stateDirectory, "os"),
  }
}

export function livePtySocketPaths(stateDirectory: string) {
  const runtime = hostKernelRuntime(stateDirectory)
  const session = `s-${"0".repeat(20)}`
  return [
    join(runtime.stateRoot, "state", session, `s-${"0".repeat(16)}.sock`),
    join(runtime.hostKernelStateRoot, "state", session, `host-${"0".repeat(16)}.sock`),
  ] as const
}

export function livePtyFixtureRoot() {
  return join(resolve(import.meta.dir, "../../../../.tmp"), "p-XXXXXX")
}

export type LivePtyContext = {
  readonly supervisor: SessionSupervisorInterface
  readonly pty: Pty.Interface
  readonly events: EventV2.Interface
  readonly workspace: string
  readonly locationRef: typeof Location.Ref.Type
}

export type StartApprovalState = "eligible" | "unavailable" | "no-kernel"

// PTY-002's positive lifecycle needs an *approvable* `terminal.start` Guard challenge. The
// kernel's consent projection currently enables `allow` only when it can render an assessed
// argument summary, and that summary is wired for `terminal.run` only, so `terminal.start`
// challenges arrive with `allowEnabled=false` and Core's approval surface must refuse them
// (supervisor.ts: "Guard allow is unavailable without assessed guarantees"). Probe the real
// capability once at suite load so the lifecycle cases run exactly when the kernel side can
// approve a start and are explicitly skipped — never silently passing — until then.
export async function probeStartApproval(): Promise<StartApprovalState> {
  if (!liveHostKernelAvailable) return "no-kernel"
  const bash = Bun.which("bash")
  if (!bash) return "unavailable"
  return await withLivePty(({ pty, workspace }) =>
    Effect.gen(function* () {
      // A rejected allow reply leaves the Guard challenge pending, so the probe must be
      // bounded or suite load would wait forever; a timeout is the same answer as an
      // unapprovable challenge.
      const result = yield* pty
        .create({ command: bash, args: ["-c", "exec true"], cwd: workspace, env: {} })
        .pipe(
          Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.succeed("timeout" as const) }),
          Effect.exit,
        )
      if (Exit.isSuccess(result)) {
        if (result.value === "timeout") return "unavailable" as const
        yield* pty.remove(result.value.id).pipe(Effect.ignore)
        return "eligible" as const
      }
      const error = Cause.squash(result.cause)
      if (error instanceof Error && error.message.includes("Guard allow is unavailable")) {
        return "unavailable" as const
      }
      throw error
    }),
  )
}

export interface LivePtyOptions {
  readonly config?: Layer.Layer<Config.Service>
  readonly decide?: (request: GuardApprovalRequest) => "allow_once" | "deny"
}

export async function withLivePty<T, R>(
  body: (context: LivePtyContext) => Effect.Effect<T, unknown, R>,
  options: LivePtyOptions = {},
): Promise<T> {
  if (!liveHostKernelAvailable) {
    throw new Error(`host kernel binary is unavailable: build ${hostKernelRust}`)
  }
  const fixtureRoot = resolve(import.meta.dir, "../../../../.tmp")
  mkdirSync(fixtureRoot, { recursive: true })
  const dir = mkdtempSync(livePtyFixtureRoot())
  const workspacePath = join(dir, "workspace")
  mkdirSync(workspacePath)
  const workspace = realpathSync(workspacePath)
  try {
    const layer = AppNodeBuilder.build(LayerNode.group([SessionSupervisor.node, Pty.node, EventV2.node]), [
      [
        Database.node,
        makeGlobalNode({
          service: Database.Service,
          layer: Database.layerFromPath(join(dir, "opencode.db")),
          deps: [],
        }),
      ],
      [Config.node, options.config ?? Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })],
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(workspace) }))),
      ],
      [
        SessionSupervisor.runtimeConfigNode,
        Layer.succeed(SessionSupervisor.RuntimeConfig, SessionSupervisor.RuntimeConfig.of(hostKernelRuntime(dir))),
      ],
    ])

    const program = Effect.scoped(
      Effect.gen(function* () {
        const supervisor = yield* SessionSupervisor.Service
        const pty = yield* Pty.Service
        const events = yield* EventV2.Service
        const locationRef = Location.Ref.make({ directory: AbsolutePath.make(workspace) })
        // The live fixture answers the Guard challenge exactly like the app's approval
        // surface: learn the approval identifier from `guard.approval.requested`, then
        // reply through the supervisor. `decide` lets a case deny instead.
        const decide = options.decide ?? (() => "allow_once" as const)
        const approvals = yield* Queue.unbounded<GuardApprovalRequest>()
        yield* events.listen((event) => {
          if (event.type === GuardApprovalRequested.type) {
            Queue.offerUnsafe(approvals, event.data as GuardApprovalRequest)
          }
          return Effect.void
        })
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            while (true) {
              const request = yield* Queue.take(approvals)
              yield* supervisor
                .replyGuardApproval({ approvalID: request.approvalID, decision: decide(request) })
                .pipe(
                  Effect.provideService(TrustedPrincipalContext, { principal: livePrincipal }),
                  Effect.catchCause((cause) => Effect.logWarning("pty live guard approval reply failed", cause)),
                )
            }
          }),
        )
        return yield* body({ supervisor, pty, events, workspace, locationRef })
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.provideService(TrustedPrincipalContext, { principal: livePrincipal }),
    )
    // The private fixture layer and explicit authenticated test principal above satisfy this
    // live adapter's complete environment before the test program reaches runPromise.
    return await Effect.runPromise(program as Effect.Effect<T, unknown, never>)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
