import { afterAll, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Queue } from "effect"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Database } from "@opencode-ai/core/database/database"
import { Location } from "@opencode-ai/core/location"
import type { EventV2 } from "@opencode-ai/core/event"
import { buildLocationServiceMap, LocationServiceMap, locationServiceMapNode } from "@opencode-ai/core/location-services"
import { Pty } from "@opencode-ai/core/pty"
import { AbsolutePath } from "@opencode-ai/core/schema"
import {
  GuardApprovalRequested,
  SessionSupervisor,
  type Interface as SessionSupervisorInterface,
  type GuardApprovalRequest,
} from "@opencode-ai/core/session/supervisor"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Plugin } from "../../src/plugin"
import { SessionID, MessageID } from "../../src/session/schema"
import { ShellTool } from "../../src/tool/shell"
import { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { testInstanceStoreLayer, tmpdirScoped, provideInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const shellLayer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
    ]),
  ),
  testInstanceStoreLayer,
)
const it = testEffect(shellLayer)

const initShell = Effect.fn("ShellToolTest.init")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})

const run = Effect.fn("ShellToolTest.run")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = context,
) {
  const bash = yield* initShell()
  return yield* bash.execute(args, next)
})

const fail = Effect.fn("ShellToolTest.fail")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = context,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause)
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error("expected shell execution to fail")
})

const runIn = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) => effect.pipe(provideInstance(directory))

const context: Tool.Context = {
  sessionID: SessionID.make("ses_guarded_shell"),
  messageID: MessageID.make("msg_guarded_shell"),
  callID: "call_guarded_shell",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const quote = (value: string) => `"${value.replaceAll('"', '\\"')}"`
const commandThatWouldLaunch = (marker: string) =>
  `${quote(process.execPath)} -e ${quote("require('node:fs').writeFileSync(process.argv[1], 'launched')")} ${quote(marker)}`

describe("tool.shell Guard boundary", () => {
  it.live("denies missing, challenge-only, and malformed leases before launching a process", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const marker = path.join(directory, "shell-was-launched")
      let legacyApprovalCalls = 0
      const challengeOnly: Tool.Context = {
        ...context,
        effect: {
          challengeID: "challenge_only",
          effectID: "effect_only",
          target: directory,
          resource: "shell",
          existed: false,
        },
        ask: () => Effect.sync(() => { legacyApprovalCalls++ }).pipe(Effect.asVoid),
      }
      const malformedLease: Tool.Context = {
        ...context,
        extra: { guardedLease: { effectID: "effect_bad", capabilityLeaseDigest: "not-a-kernel-lease" } },
      }

      for (const candidate of [context, challengeOnly, malformedLease]) {
        const error = yield* runIn(directory, fail({ command: commandThatWouldLaunch(marker) }, candidate))
        expect(error.message).toContain("Shell denied: missing Rust Guard lease")
        expect(existsSync(marker)).toBe(false)
      }
      expect(legacyApprovalCalls).toBe(0)
    }),
    // Loading the Config/Agent/Plugin graph can exceed the 5s default on a loaded
    // machine; the denials under test are immediate once the layer is built.
    { timeout: 20_000 },
  )

  // C13/PTY-001 negative: `Permission` auto-accept/always and legacy `ctx.ask` are not
  // authorization. ShellTool must require a Rust-issued one-use lease and must never
  // consult the prompt surface, even when the Permission service would answer allow.
  it.live("permission auto-accept/always and ctx.ask cannot authorize a shell call", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const marker = path.join(directory, "shell-permission-was-launched")
      let asked = 0
      const autoAccept: Tool.Context = {
        ...context,
        effect: {
          challengeID: "challenge_auto_accept",
          effectID: "effect_auto_accept",
          target: directory,
          resource: "shell",
          existed: false,
        },
        // Stands in for a Permission rule that auto-accepts (or persists "always").
        ask: () => Effect.sync(() => { asked++ }).pipe(Effect.asVoid),
      }
      // A well-formed but client-supplied lease must not be trusted locally either; only
      // the real location-scoped runtime can present a kernel-issued lease.
      const forgedLease: Tool.Context = {
        ...autoAccept,
        extra: { guardedLease: { effectID: "effect_forged", capabilityLeaseDigest: `blake3:${"a".repeat(64)}` } },
      }

      const permissionError = yield* runIn(directory, fail({ command: commandThatWouldLaunch(marker) }, autoAccept))
      expect(permissionError.message).toContain("Shell denied: missing Rust Guard lease")
      const forgedError = yield* runIn(directory, fail({ command: commandThatWouldLaunch(marker) }, forgedLease))
      expect(forgedError.message).toContain("Shell denied: missing authenticated principal")
      expect(asked).toBe(0)
      expect(existsSync(marker)).toBe(false)
    }),
    { timeout: 20_000 },
  )
})

// C13/PTY-001 live acceptance: the real host kernel, the app's location graph and an
// explicit `allow_once` Guard challenge. The tool must execute only the prepared
// `terminal.run` arguments and surface the kernel receipt; a tampered guarded patch
// must be refused by the kernel's one-use capability lease.
const liveRoot = mkdtempSync(path.join(tmpdir(), "opencode-shell-live-"))
afterAll(() => rmSync(liveRoot, { recursive: true, force: true }))

const hostKernelPath = path.resolve(import.meta.dir, "../../../../kernel/target/debug/hz-kernel")
const sessionSupervisorPath = path.resolve(import.meta.dir, "../../../../kernel/target/debug/session_supervisor")
const hostKernelBinaryAvailable = process.platform === "linux" && existsSync(hostKernelPath)
const liveRustAvailable = hostKernelBinaryAvailable && existsSync(sessionSupervisorPath)

const binaryManifest = (binary: string, binaryName: string) =>
  JSON.stringify({
    schemaVersion: 1,
    status: "available",
    binaryName,
    target: `linux-${process.arch}-gnu`,
    sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  })

const liveRuntimeNode = LayerNode.make({
  service: SessionSupervisor.RuntimeConfig,
  layer: Layer.succeed(
    SessionSupervisor.RuntimeConfig,
    SessionSupervisor.RuntimeConfig.of({
      assetPath: liveRustAvailable ? sessionSupervisorPath : undefined,
      manifestJSON: liveRustAvailable ? binaryManifest(sessionSupervisorPath, "session_supervisor") : undefined,
      installRoot: path.join(liveRoot, "session-observer-install"),
      stateRoot: path.join(liveRoot, "session-observer-state"),
      hostKernelAssetPath: liveRustAvailable ? hostKernelPath : undefined,
      hostKernelManifestJSON: liveRustAvailable ? binaryManifest(hostKernelPath, "hz-kernel") : undefined,
      hostKernelInstallRoot: path.join(liveRoot, "host-kernel-install"),
      hostKernelStateRoot: path.join(liveRoot, "host-kernel-state"),
    }),
  ),
  deps: [],
})

const liveLocationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: buildLocationServiceMap([[SessionSupervisor.runtimeConfigNode, liveRuntimeNode]]),
  deps: [],
})

const liveDatabaseNode = makeGlobalNode({
  service: Database.Service,
  layer: Database.layerFromPath(path.join(liveRoot, "shell-live.sqlite")),
  deps: [],
})

const liveShellLayer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
      EventV2Bridge.node,
      SessionSupervisor.node,
      Database.node,
      locationServiceMapNode,
    ]),
    [
      [Database.node, liveDatabaseNode],
      [SessionSupervisor.runtimeConfigNode, liveRuntimeNode],
      [locationServiceMapNode, liveLocationServiceMapNode],
    ],
  ),
  testInstanceStoreLayer,
  Layer.succeed(TrustedPrincipalContext, {
    principal: { kind: "server_auth" as const, subject: "shell-live-test" },
  }),
)
const liveIt = testEffect(liveShellLayer)
const withLiveShell = liveRustAvailable ? liveIt.live : liveIt.live.skip

const liveTurnContextDigest = `sha256:${"a".repeat(64)}`

const liveApprovalResponder = (
  events: EventV2.Interface,
  supervisor: SessionSupervisorInterface,
  decision: "allow_once" | "deny",
) =>
  Effect.gen(function* () {
    const approvals = yield* Queue.unbounded<GuardApprovalRequest>()
    const off = yield* events.listen((event) => {
      if (event.type === GuardApprovalRequested.type) {
        Queue.offerUnsafe(approvals, event.data as GuardApprovalRequest)
      }
      return Effect.void
    })
    yield* Effect.addFinalizer(() => off)
    return { approvals, reply: Effect.gen(function* () {
      const request = yield* Queue.take(approvals)
      expect(request.capabilityID).toBe("terminal.run")
      yield* supervisor.replyGuardApproval({ approvalID: request.approvalID, decision })
      return request
    }) }
  })

describe("tool.shell live Guard admission", () => {
  withLiveShell(
    "executes an approved bash call through the real terminal.run lease and receipt",
    () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        const marker = path.join(directory, "shell-live-marker")
        const command = `printf 'SHELL_LIVE_STDOUT\\n'; touch '${marker}'`
        const locationRef = Location.Ref.make({ directory: AbsolutePath.make(directory) })
        const locations = yield* LocationServiceMap.Service
        const pty = yield* Pty.Service.pipe(Effect.provide(locations.get(locationRef)))
        const supervisor = yield* SessionSupervisor.Service
        const events = yield* EventV2Bridge.Service
        const { reply } = yield* liveApprovalResponder(events, supervisor, "allow_once")
        const responder = yield* Effect.forkChild(reply)
        const sessionID = SessionID.make("ses_shell_live_approved")

        const prepared = yield* pty.prepareToolBatch({
          sessionID,
          locationRef,
          batchID: "batch_shell_live_approved",
          turnContextDigest: liveTurnContextDigest,
          calls: [
            {
              callID: "call_shell_live_approved",
              capabilityID: "terminal.run",
              arguments: { command, cwd: directory, timeoutMs: 30_000 },
            },
          ],
        })
        yield* Fiber.join(responder)
        if (prepared.admission.status !== "prepared") {
          return yield* Effect.die(
            new Error(`approved shell batch was not prepared: ${JSON.stringify(prepared.admission)}`),
          )
        }

        const result = yield* runIn(
          directory,
          run(
            { command, workdir: directory },
            {
              ...context,
              sessionID,
              trustedPrincipal: { kind: "server_auth", subject: "shell-live-test" },
              extra: {
                guardedLease: prepared.admission.lease,
                guardedPatch: prepared.calls[0]!.arguments,
              },
            },
          ),
        )
        return { result, marker: existsSync(marker) }
      }),
    { timeout: 120_000 },
  )

  withLiveShell(
    "refuses a guarded patch that differs from the approved terminal.run arguments",
    () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        const approvedMarker = path.join(directory, "shell-live-approved-marker")
        const tamperedMarker = path.join(directory, "shell-live-tampered-marker")
        const approvedCommand = `touch '${approvedMarker}'`
        const locationRef = Location.Ref.make({ directory: AbsolutePath.make(directory) })
        const locations = yield* LocationServiceMap.Service
        const pty = yield* Pty.Service.pipe(Effect.provide(locations.get(locationRef)))
        const supervisor = yield* SessionSupervisor.Service
        const events = yield* EventV2Bridge.Service
        const { reply } = yield* liveApprovalResponder(events, supervisor, "allow_once")
        const responder = yield* Effect.forkChild(reply)
        const sessionID = SessionID.make("ses_shell_live_tampered")

        const prepared = yield* pty.prepareToolBatch({
          sessionID,
          locationRef,
          batchID: "batch_shell_live_tampered",
          turnContextDigest: liveTurnContextDigest,
          calls: [
            {
              callID: "call_shell_live_tampered",
              capabilityID: "terminal.run",
              arguments: { command: approvedCommand, cwd: directory, timeoutMs: 30_000 },
            },
          ],
        })
        yield* Fiber.join(responder)
        if (prepared.admission.status !== "prepared") {
          return yield* Effect.die(
            new Error(`tamper probe batch was not prepared: ${JSON.stringify(prepared.admission)}`),
          )
        }

        const exit = yield* runIn(
          directory,
          run(
            { command: approvedCommand, workdir: directory },
            {
              ...context,
              sessionID,
              trustedPrincipal: { kind: "server_auth", subject: "shell-live-test" },
              extra: {
                guardedLease: prepared.admission.lease,
                guardedPatch: {
                  ...(prepared.calls[0]!.arguments as Record<string, unknown>),
                  command: `touch '${tamperedMarker}'`,
                },
              },
            },
          ),
        ).pipe(Effect.exit)
        return {
          exit,
          approvedMarker: existsSync(approvedMarker),
          tamperedMarker: existsSync(tamperedMarker),
        }
      }),
    { timeout: 120_000 },
  )
})
