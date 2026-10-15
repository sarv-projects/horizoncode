import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Cause, Effect, Exit, Fiber, Layer, Queue } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Database } from "@opencode-ai/core/database/database"
import { Config } from "@opencode-ai/core/config"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Pty } from "@opencode-ai/core/pty"
import { Shell } from "@opencode-ai/core/shell"
import { AbsolutePath } from "@opencode-ai/core/schema"
import {
  GuardApprovalRequested,
  SessionSupervisor,
  type GuardApprovalRequest,
  type Interface as SessionSupervisorInterface,
} from "@opencode-ai/core/session/supervisor"
import { TrustedPrincipalContext } from "@opencode-ai/core/trusted-principal"
import { location } from "./fixture/location"

// Live Core -> Rust acceptance for the guarded one-shot `terminal.run` path. The
// host-scoped kernel binary is packaged exactly like `packages/opencode/script/build.ts`
// and the wider Core graph is assembled the same way `kernel-projection-live.test.ts`
// assembles it, so these cases exercise the real Guard, effect and terminal process.
const hostKernelRust = resolve(import.meta.dir, "../../../kernel/target/debug/hz-kernel")
const sessionID = "ses_terminal_run_live"
const turnContextDigest = `sha256:${"d".repeat(64)}`
const resolvedEnvironment: Record<string, string> = {}

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

type LiveContext = {
  readonly supervisor: SessionSupervisorInterface
  readonly pty: Pty.Interface
  readonly events: EventV2.Interface
  readonly workspace: string
  readonly locationRef: typeof Location.Ref.Type
  readonly approvals: Queue.Queue<GuardApprovalRequest>
}

// `terminal.v1` resolves `terminal.run` against the host kernel's shell-profile registry,
// so the app registers the discovered profile before it prepares a batch.
const registerShellProfile = (supervisor: SessionSupervisorInterface) =>
  Effect.gen(function* () {
    const profiles = yield* Effect.promise(() => Shell.discoverProfiles())
    const registered = yield* supervisor.requestHostKernel("terminal.v1", "register_shell_profiles", {
      defaultProfileKey: profiles[0]!.profileKey,
      profiles,
    })
    const entries = registered.profiles
    if (!Array.isArray(entries)) return yield* Effect.die(new Error("host kernel registered no shell profile"))
    const entry = entries[0]
    if (typeof entry !== "object" || entry === null || !("shellProfileID" in entry)) {
      return yield* Effect.die(new Error("host kernel returned an invalid shell profile"))
    }
    return entry.shellProfileID
  })

// One private host kernel, one Location, one approval channel per case.
async function withLiveHostKernel<T>(body: (context: LiveContext) => Effect.Effect<T, unknown, never>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "hc-terminal-run-live-"))
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
      [Config.node, Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })],
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(workspace) }))),
      ],
      [
        SessionSupervisor.runtimeConfigNode,
        Layer.succeed(SessionSupervisor.RuntimeConfig, SessionSupervisor.RuntimeConfig.of(hostKernelRuntime(dir))),
      ],
    ])

    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* SessionSupervisor.Service
          const pty = yield* Pty.Service
          const events = yield* EventV2.Service
          const locationRef = Location.Ref.make({ directory: AbsolutePath.make(workspace) })
          // The running app learns the approval identifier from the published
          // `guard.approval.requested` event and answers through `replyGuardApproval`.
          const approvals = yield* Queue.unbounded<GuardApprovalRequest>()
          yield* events.listen((event) => {
            if (event.type === GuardApprovalRequested.type) {
              Queue.offerUnsafe(approvals, event.data as GuardApprovalRequest)
            }
            return Effect.void
          })
          return yield* body({ supervisor, pty, events, workspace, locationRef, approvals })
        }),
      ).pipe(Effect.provide(layer)),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const replyWhenRequested = (
  approvals: Queue.Queue<GuardApprovalRequest>,
  supervisor: SessionSupervisorInterface,
  decision: "allow_once" | "deny",
) =>
  Effect.gen(function* () {
    const request = yield* Queue.take(approvals)
    expect(request.capabilityID).toBe("terminal.run")
    expect(request.sessionID).toBe(sessionID)
    // `replyGuardApproval` resolves the pending approval against the caller's trusted
    // principal; the host-OS principal is what a local CLI/TUI request carries.
    yield* supervisor
      .replyGuardApproval({ approvalID: request.approvalID, decision })
      .pipe(Effect.provideService(TrustedPrincipalContext, { principal: { kind: "host_os" } }))
    return request
  })

const replyUserApproval = (
  approvals: Queue.Queue<GuardApprovalRequest>,
  supervisor: SessionSupervisorInterface,
  decision: "allow_once" | "deny",
) =>
  Effect.gen(function* () {
    const request = yield* Queue.take(approvals)
    expect(request.capabilityID).toBe("terminal.run")
    expect(request.sessionID).toBeUndefined()
    yield* supervisor
      .replyGuardApproval({ approvalID: request.approvalID, decision })
      .pipe(Effect.provideService(TrustedPrincipalContext, { principal: { kind: "host_os" } }))
  })

describe("guarded terminal.run through the real host kernel", () => {
  test("host kernel admits, executes and over-limit-rejects a terminal.run batch (RPC acceptance)", async () => {
    const outcome = await withLiveHostKernel(({ supervisor, workspace, locationRef }) =>
      Effect.gen(function* () {
        const shellProfile = yield* registerShellProfile(supervisor)
        const locationID = yield* supervisor.registerHostLocation(locationRef)
        const prepare = (input: { readonly batchID: string; readonly callID: string; readonly command: string; readonly timeoutMs: number }) =>
          supervisor.requestHostKernel("effects.v2", "prepare_tool_batch", {
            sessionID,
            locationID,
            batchID: input.batchID,
            turnContextDigest,
            calls: [
              {
                callID: input.callID,
                capabilityID: "terminal.run",
                arguments: {
                  shellProfileID: shellProfile,
                  command: input.command,
                  cwd: workspace,
                  timeoutMs: input.timeoutMs,
                  resolvedEnvironment,
                },
              },
            ],
          })
        const run = (lease: { readonly effectID: string; readonly capabilityLeaseDigest: string }, command: string, timeoutMs: number) =>
          supervisor.requestHostKernel("terminal.v1", "run", {
            effectID: lease.effectID,
            capabilityLeaseDigest: lease.capabilityLeaseDigest,
            locationID,
            sessionID,
            shellProfileID: shellProfile,
            command,
            cwd: workspace,
            timeoutMs,
            resolvedEnvironment,
          })

        // deny path
        const deniedChallenge = yield* prepare({
          batchID: "batch_rpc_denied",
          callID: "call_rpc_denied",
          command: "printf 'DENIED_STDOUT\\n'; touch marker-rpc-denied.txt",
          timeoutMs: 30_000,
        })
        const denial = yield* supervisor.requestHostKernel("effects.v2", "resolve_approval", {
          challengeID: deniedChallenge.challengeID,
          decision: "deny",
        })
        const deniedMarker = existsSync(join(workspace, "marker-rpc-denied.txt"))
        const deniedLeaseProbe = yield* Effect.exit(
          run(
            { effectID: String(deniedChallenge.effectID), capabilityLeaseDigest: `blake3:${"0".repeat(64)}` },
            "touch marker-rpc-denied-lease.txt",
            30_000,
          ),
        )

        // allow path
        const approvedChallenge = yield* prepare({
          batchID: "batch_rpc_approved",
          callID: "call_rpc_approved",
          command: "printf 'TERMINAL_LIVE_STDOUT\\n'; touch marker-rpc-approved.txt",
          timeoutMs: 30_000,
        })
        const approval = yield* supervisor.requestHostKernel("effects.v2", "resolve_approval", {
          challengeID: approvedChallenge.challengeID,
          decision: "allow_once",
        })
        const result = yield* run(
          { effectID: String(approval.effectID), capabilityLeaseDigest: String(approval.capabilityLeaseDigest) },
          "printf 'TERMINAL_LIVE_STDOUT\\n'; touch marker-rpc-approved.txt",
          30_000,
        )
        const approvedMarker = existsSync(join(workspace, "marker-rpc-approved.txt"))

        // over-limit call
        const overLimit = yield* Effect.exit(
          prepare({
            batchID: "batch_rpc_overlimit",
            callID: "call_rpc_overlimit",
            command: "touch marker-rpc-overlimit.txt",
            timeoutMs: 600_001,
          }),
        )

        return {
          deniedStatus: deniedChallenge.status,
          approvalTargets: deniedChallenge.targets,
          expiryType: typeof deniedChallenge.expiresAtUnixMs,
          denialStatus: denial.status,
          deniedMarker,
          deniedLeaseProbe,
          approvedStatus: approvedChallenge.status,
          approvalStatus: approval.status,
          result,
          approvedMarker,
          overLimit,
          overLimitMarker: existsSync(join(workspace, "marker-rpc-overlimit.txt")),
        }
      }),
    )

    // deny path
    expect(outcome.deniedStatus).toBe("needs_approval")
    expect(outcome.denialStatus).toBe("denied")
    expect(outcome.deniedMarker).toBe(false)
    expect(Exit.isFailure(outcome.deniedLeaseProbe)).toBe(true)

    // The host kernel describes terminal targets as `operation: "run"` and sends the
    // challenge expiry as a MessagePack uint64 (a BigInt once decoded by msgpackr).
    // `SessionSupervisor.prepareToolBatch` accepts neither shape today
    // (`packages/core/src/session/supervisor.ts:655` rejects every operation other
    // than write/delete, `:2433` requires a safe-integer `expiresAtUnixMs`).
    expect(outcome.approvalTargets).toMatchObject([{ operation: "run", resource: "." }])
    expect(outcome.expiryType).toBe("bigint")

    // allow path
    expect(outcome.approvedStatus).toBe("needs_approval")
    expect(outcome.approvalStatus).toBe("approved")
    expect(outcome.result.status).toBe("exited")
    expect(outcome.result.exitCode).toBe(0)
    expect(String(outcome.result.preview)).toContain("TERMINAL_LIVE_STDOUT")
    expect(outcome.result.previewTruncated).toBe(false)
    expect(outcome.result.artifactTruncated).toBe(false)
    expect(String(outcome.result.artifactRef).length).toBeGreaterThan(0)
    expect(String(outcome.result.receiptRef).length).toBeGreaterThan(0)
    expect(outcome.approvedMarker).toBe(true)

    // over-limit call
    expect(Exit.isFailure(outcome.overLimit)).toBe(true)
    expect(outcome.overLimitMarker).toBe(false)
  }, 90000)

  test("Core refuses to execute a denied terminal.run tool batch", async () => {
    const outcome = await withLiveHostKernel(({ supervisor, pty, approvals, workspace, locationRef }) =>
      Effect.gen(function* () {
        const responder = yield* Effect.forkChild(replyWhenRequested(approvals, supervisor, "deny"))
        const prepared = yield* pty.prepareToolBatch({
          sessionID,
          locationRef,
          batchID: "batch_terminal_denied",
          turnContextDigest,
          calls: [
            {
              callID: "call_terminal_denied",
              capabilityID: "terminal.run",
              arguments: {
                command: "printf 'DENIED_STDOUT\\n'; touch marker-denied.txt",
                cwd: workspace,
                timeoutMs: 30_000,
              },
            },
          ],
        })
        yield* Fiber.join(responder)
        return { admission: prepared.admission, marker: existsSync(join(workspace, "marker-denied.txt")) }
      }),
    )

    expect(outcome.admission).toEqual({ status: "denied", reason: "Guard approval was denied" })
    expect(outcome.marker).toBe(false)
  }, 60000)

  test("Core executes an approved terminal.run tool batch through its capability lease", async () => {
    const outcome = await withLiveHostKernel(({ supervisor, pty, approvals, workspace, locationRef }) =>
      Effect.gen(function* () {
        const responder = yield* Effect.forkChild(replyWhenRequested(approvals, supervisor, "allow_once"))
        const prepared = yield* pty.prepareToolBatch({
          sessionID,
          locationRef,
          batchID: "batch_terminal_approved",
          turnContextDigest,
          calls: [
            {
              callID: "call_terminal_approved",
              capabilityID: "terminal.run",
              arguments: {
                command: "printf 'TERMINAL_LIVE_STDOUT\\n'; touch marker-approved.txt",
                cwd: workspace,
                timeoutMs: 30_000,
              },
            },
          ],
        })
        yield* Fiber.join(responder)
        if (prepared.admission.status !== "prepared") {
          return yield* Effect.die(
            new Error(`approved batch was not prepared: ${JSON.stringify(prepared.admission)}`),
          )
        }
        const result = yield* pty.runTool({
          sessionID,
          locationRef,
          lease: prepared.admission.lease,
          call: prepared.calls[0]!,
        })
        return { result, marker: existsSync(join(workspace, "marker-approved.txt")) }
      }),
    )

    expect(outcome.result.status).toBe("exited")
    expect(outcome.result.exitCode).toBe(0)
    expect(outcome.result.preview).toContain("TERMINAL_LIVE_STDOUT")
    expect(outcome.result.preview.length).toBeGreaterThan(0)
    expect(typeof outcome.result.previewTruncated).toBe("boolean")
    expect(typeof outcome.result.artifactTruncated).toBe("boolean")
    expect(outcome.result.artifactRef.length).toBeGreaterThan(0)
    expect(outcome.result.receiptRef.length).toBeGreaterThan(0)
    expect(outcome.marker).toBe(true)
  }, 60000)

  test("Core rejects an over-limit terminal.run call before any process starts", async () => {
    const outcome = await withLiveHostKernel(({ pty, approvals, workspace, locationRef }) =>
      Effect.gen(function* () {
        const overLimit = yield* Effect.exit(
          pty.prepareToolBatch({
            sessionID,
            locationRef,
            batchID: "batch_terminal_overlimit",
            turnContextDigest,
            calls: [
              {
                callID: "call_terminal_overlimit",
                capabilityID: "terminal.run",
                arguments: { command: "touch marker-overlimit.txt", cwd: workspace, timeoutMs: 600_001 },
              },
            ],
          }),
        )
        return { overLimit, approvals: yield* Queue.size(approvals), marker: existsSync(join(workspace, "marker-overlimit.txt")) }
      }),
    )

    expect(Exit.isFailure(outcome.overLimit)).toBe(true)
    expect(JSON.stringify(outcome.overLimit)).toContain("Timeout must be between 1 and 600000 milliseconds")
    expect(outcome.approvals).toBe(0)
    expect(outcome.marker).toBe(false)
  }, 60000)

  test("host kernel consumes a terminal.run capability lease exactly once", async () => {
    const outcome = await withLiveHostKernel(({ supervisor, workspace, locationRef }) =>
      Effect.gen(function* () {
        const shellProfile = yield* registerShellProfile(supervisor)
        const locationID = yield* supervisor.registerHostLocation(locationRef)
        const runArguments = {
          shellProfileID: shellProfile,
          command: "printf 'RUN\\n' >> marker-once.txt",
          cwd: workspace,
          timeoutMs: 30_000,
          resolvedEnvironment,
        }
        const challenge = yield* supervisor.requestHostKernel("effects.v2", "prepare_tool_batch", {
          sessionID,
          locationID,
          batchID: "batch_lease_once",
          turnContextDigest,
          calls: [{ callID: "call_lease_once", capabilityID: "terminal.run", arguments: runArguments }],
        })
        const approval = yield* supervisor.requestHostKernel("effects.v2", "resolve_approval", {
          challengeID: challenge.challengeID,
          decision: "allow_once",
        })
        const lease = {
          effectID: String(approval.effectID),
          capabilityLeaseDigest: String(approval.capabilityLeaseDigest),
        }
        const reconcile = () =>
          supervisor.requestHostKernel("effects.v2", "reconcile_effect", {
            effectID: lease.effectID,
            locationID,
            sessionID,
          })
        const run = () =>
          supervisor.requestHostKernel("terminal.v1", "run", { ...lease, locationID, sessionID, ...runArguments })

        const beforeRun = yield* reconcile()
        const first = yield* run()
        const afterFirstRun = yield* Effect.sync(() => readFileSync(join(workspace, "marker-once.txt"), "utf8"))
        const replay = yield* Effect.exit(run())
        const afterReplay = yield* Effect.sync(() => readFileSync(join(workspace, "marker-once.txt"), "utf8"))
        const settled = yield* reconcile()

        return {
          beforeRunStatus: beforeRun.status,
          firstStatus: first.status,
          afterFirstRun,
          replay,
          replayMessage: Exit.isFailure(replay)
            ? Cause.prettyErrors(replay.cause)
                .map((error) => error.message)
                .join("\n")
            : "",
          afterReplay,
          settledStatus: settled.status,
          settledReceipt: settled.receiptDigest,
        }
      }),
    )

    // An approved-but-undispatched effect is a durable APPROVED intent, never a settlement.
    expect(outcome.beforeRunStatus).toBe("approved")
    expect(outcome.firstStatus).toBe("exited")
    expect(outcome.afterFirstRun).toBe("RUN\n")

    // Replaying the consumed one-use lease must be refused, and the refused attempt must
    // not spawn anything: the appended line count is unchanged.
    expect(Exit.isFailure(outcome.replay)).toBe(true)
    expect(outcome.replayMessage).toBe(
      "Session supervisor effect failed: capability lease is missing or consumed",
    )
    expect(outcome.afterReplay).toBe("RUN\n")

    expect(outcome.settledStatus).toBe("settled")
    expect(String(outcome.settledReceipt)).toMatch(/^blake3:[0-9a-f]{64}$/)
  }, 90000)

  test("a run past its deadline settles timed_out with a receipt, leaks no orphan and has no cancel channel", async () => {
    const outcome = await withLiveHostKernel(({ supervisor, workspace, locationRef }) =>
      Effect.gen(function* () {
        const shellProfile = yield* registerShellProfile(supervisor)
        const locationID = yield* supervisor.registerHostLocation(locationRef)
        const runArguments = {
          shellProfileID: shellProfile,
          command: "sleep 987",
          cwd: workspace,
          timeoutMs: 800,
          resolvedEnvironment,
        }
        const challenge = yield* supervisor.requestHostKernel("effects.v2", "prepare_tool_batch", {
          sessionID,
          locationID,
          batchID: "batch_deadline",
          turnContextDigest,
          calls: [{ callID: "call_deadline", capabilityID: "terminal.run", arguments: runArguments }],
        })
        const approval = yield* supervisor.requestHostKernel("effects.v2", "resolve_approval", {
          challengeID: challenge.challengeID,
          decision: "allow_once",
        })
        const lease = {
          effectID: String(approval.effectID),
          capabilityLeaseDigest: String(approval.capabilityLeaseDigest),
        }
        const startedAt = Date.now()
        const result = yield* supervisor.requestHostKernel("terminal.v1", "run", {
          ...lease,
          locationID,
          sessionID,
          ...runArguments,
        })
        const elapsedMs = Date.now() - startedAt
        const settled = yield* supervisor.requestHostKernel("effects.v2", "reconcile_effect", {
          effectID: lease.effectID,
          locationID,
          sessionID,
        })
        const orphans = yield* Effect.sync(() => Bun.spawnSync(["pgrep", "-f", "sleep 987"]))
        // `terminal.cancel` is the only cancellation channel the LLD defines for a run
        // (`arch_V1/37-RUNTIME-SERVICE-LLD.md:328`) and it is terminal-scoped.
        const cancel = yield* Effect.exit(
          supervisor.requestHostKernel("terminal.v1", "cancel", {
            effectID: lease.effectID,
            terminalID: "pty_terminal_run_live",
            generation: 1,
            reason: "one-shot cancellation probe",
          }),
        )
        return {
          status: result.status,
          exitCode: result.exitCode,
          receiptRef: result.receiptRef,
          artifactTruncated: result.artifactTruncated,
          elapsedMs,
          settledStatus: settled.status,
          settledReceipt: settled.receiptDigest,
          orphanExit: orphans.exitCode,
          orphanStdout: orphans.stdout.toString().trim(),
          cancel,
        }
      }),
    )

    // A killed-at-deadline run settles as timed_out with a receipt; never a silent success.
    expect(outcome.status).toBe("timed_out")
    expect(typeof outcome.exitCode).toBe("number")
    expect(String(outcome.receiptRef)).toMatch(/^blake3:[0-9a-f]{64}$/)
    expect(outcome.settledStatus).toBe("settled")
    expect(String(outcome.settledReceipt)).toMatch(/^blake3:[0-9a-f]{64}$/)

    // The kernel killed the whole PTY process group: no `sleep 987` survives, and the
    // call returned after the deadline rather than after the command.
    expect(outcome.elapsedMs).toBeLessThan(10_000)
    expect(outcome.orphanExit).toBe(1)
    expect(outcome.orphanStdout).toBe("")

    // `terminal.cancel` is terminal-scoped: a one-shot run has no interactive terminal
    // session, so the host refuses the cancel and the settled run is never touched.
    expect(Exit.isFailure(outcome.cancel)).toBe(true)
    expect(JSON.stringify(outcome.cancel)).toContain("terminal session is unavailable")
  }, 90000)

  test("an undispatchable run stays durably UNKNOWN, is never settled and is not retryable", async () => {
    const outcome = await withLiveHostKernel(({ supervisor, workspace, locationRef }) =>
      Effect.gen(function* () {
        // The kernel's POSIX bash profile only requires a file named `bash` with an
        // execute bit (`kernel/src/terminal_profile.rs:426-445`), so a private copy lets
        // this case withdraw the backend between PREPARE and dispatch.
        const probeExecutable = join(workspace, "bash")
        const discovered = yield* Effect.promise(() => Shell.discoverProfiles())
        yield* Effect.sync(() => {
          copyFileSync(discovered[0]!.executable, probeExecutable)
          chmodSync(probeExecutable, 0o755)
        })
        const registered = yield* supervisor.requestHostKernel("terminal.v1", "register_shell_profiles", {
          defaultProfileKey: "posix:bash",
          profiles: [{ profileKey: "posix:bash", kind: "posix.bash", executable: probeExecutable, login: true }],
        })
        const entries = registered.profiles
        if (!Array.isArray(entries) || typeof entries[0] !== "object" || entries[0] === null) {
          return yield* Effect.die(new Error("host kernel registered no probe shell profile"))
        }
        const shellProfile = (entries[0] as { shellProfileID: string }).shellProfileID
        const locationID = yield* supervisor.registerHostLocation(locationRef)
        const dispatch = (label: string, command: string) =>
          Effect.gen(function* () {
            const challenge = yield* supervisor.requestHostKernel("effects.v2", "prepare_tool_batch", {
              sessionID,
              locationID,
              batchID: `batch_unknown_${label}`,
              turnContextDigest,
              calls: [
                {
                  callID: `call_unknown_${label}`,
                  capabilityID: "terminal.run",
                  arguments: { shellProfileID: shellProfile, command, cwd: workspace, timeoutMs: 30_000, resolvedEnvironment },
                },
              ],
            })
            const approval = yield* supervisor.requestHostKernel("effects.v2", "resolve_approval", {
              challengeID: challenge.challengeID,
              decision: "allow_once",
            })
            const lease = {
              effectID: String(approval.effectID),
              capabilityLeaseDigest: String(approval.capabilityLeaseDigest),
            }
            const result = yield* Effect.exit(
              supervisor.requestHostKernel("terminal.v1", "run", {
                ...lease,
                locationID,
                sessionID,
                shellProfileID: shellProfile,
                command,
                cwd: workspace,
                timeoutMs: 30_000,
                resolvedEnvironment,
              }),
            )
            const reconcile = yield* Effect.exit(
              supervisor.requestHostKernel("effects.v2", "reconcile_effect", {
                effectID: lease.effectID,
                locationID,
                sessionID,
              }),
            )
            const replay = yield* Effect.exit(
              supervisor.requestHostKernel("terminal.v1", "run", {
                ...lease,
                locationID,
                sessionID,
                shellProfileID: shellProfile,
                command,
                cwd: workspace,
                timeoutMs: 30_000,
                resolvedEnvironment,
              }),
            )
            const messages = (exit: Exit.Exit<unknown, unknown>) =>
              Exit.isFailure(exit)
                ? Cause.prettyErrors(exit.cause)
                    .map((error) => error.message)
                    .join("\n")
                : ""
            return { result, reconcile, replay, resultMessage: messages(result), reconcileMessage: messages(reconcile), replayMessage: messages(replay) }
          })

        const healthy = yield* dispatch("healthy", "printf 'HEALTHY\\n'")
        yield* Effect.sync(() => rmSync(probeExecutable))
        const withdrawn = yield* dispatch("withdrawn", "printf 'WITHDRAWN\\n'")
        return { healthy, withdrawn }
      }),
    )

    // The probe backend really is the run's backend while it exists.
    expect(Exit.isSuccess(outcome.healthy.result)).toBe(true)
    expect(outcome.healthy.resultMessage).toBe("")

    // With the backend withdrawn, dispatch is uncertain: the effect is left UNKNOWN and
    // reported as an error, never as a settled run.
    expect(Exit.isFailure(outcome.withdrawn.result)).toBe(true)
    expect(outcome.withdrawn.resultMessage).toBe(
      "Session supervisor effect failed: terminal process could not be started; the effect must not be retried",
    )
    expect(outcome.withdrawn.reconcileMessage).toBe(
      "Session supervisor effect failed: effect remains UNKNOWN; it must not be retried",
    )
    expect(outcome.withdrawn.replayMessage).toBe(
      "Session supervisor effect failed: capability lease is missing or consumed",
    )
  }, 90000)

  test("Core user-origin terminal.run requires approval without fabricating a Session", async () => {
    const outcome = await withLiveHostKernel(({ supervisor, pty, approvals, workspace, locationRef }) =>
      Effect.gen(function* () {
        const principal = { principal: { kind: "host_os" as const } }
        const deniedResponder = yield* Effect.forkChild(replyUserApproval(approvals, supervisor, "deny"))
        const denied = yield* Effect.exit(
          pty
            .runUser({
              locationRef,
              command: "touch marker-user-denied.txt",
              cwd: workspace,
              timeoutMs: 30_000,
            })
            .pipe(Effect.provideService(TrustedPrincipalContext, principal)),
        )
        yield* Fiber.join(deniedResponder)

        const allowedResponder = yield* Effect.forkChild(replyUserApproval(approvals, supervisor, "allow_once"))
        const result = yield* pty
          .runUser({
            locationRef,
            command: "printf 'USER_ORIGIN_STDOUT\\n'; touch marker-user-approved.txt",
            cwd: workspace,
            timeoutMs: 30_000,
          })
          .pipe(Effect.provideService(TrustedPrincipalContext, principal))
        yield* Fiber.join(allowedResponder)
        return {
          denied,
          result,
          deniedMarker: existsSync(join(workspace, "marker-user-denied.txt")),
          approvedMarker: existsSync(join(workspace, "marker-user-approved.txt")),
        }
      }),
    )

    expect(Exit.isFailure(outcome.denied)).toBe(true)
    expect(outcome.deniedMarker).toBe(false)
    expect(outcome.result.status).toBe("exited")
    expect(outcome.result.exitCode).toBe(0)
    expect(outcome.result.preview).toContain("USER_ORIGIN_STDOUT")
    expect(outcome.result.receiptRef.length).toBeGreaterThan(0)
    expect(outcome.approvedMarker).toBe(true)
  }, 60000)
})
