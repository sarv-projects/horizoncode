import { describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
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
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import {
  GuardApprovalRequested,
  SessionSupervisor,
  directAttemptScopeToWire,
  type GuardApprovalRequest,
  type DirectAttemptScopeV1,
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
const directProfileDefinition = {
  schemaVersion: 2,
  profileId: "specialist.reader",
  revision: 1,
  name: "Reader",
  description: "Read-only specialist",
  source: "user",
  roles: ["subagent"],
  purpose: "Inspect code",
  whenToUse: "When exploring",
  whenNotToUse: "When editing",
  adapter: { kind: "native", adapterId: "horizon.native" },
  model: { providerId: "local", modelId: "small" },
  harness: "native-minimal",
  reasoning: "low",
  variants: [],
  instructions: { extraRefs: [], maxCompiledTokens: 4096 },
  tools: [{ effect: "allow", toolPattern: "files.read" }],
  allowedSkillIds: [],
  deniedSkillIds: [],
  allowedMcpServers: [],
  allowedMcpToolPatterns: [],
  allowedSubagentIds: [],
  deniedSubagentIds: [],
  pathRules: [{ effect: "allow", operation: "read", glob: "src/**" }],
  context: { isolation: "fresh", allowImages: false, allowDocuments: false, allowArtifacts: false },
  inputMode: "read_only",
  memoryPolicy: "none",
  isolation: "read_only",
  lifecycleHooks: [],
  capabilityCeiling: ["files.read"],
  limits: { maxDepth: 1, maxActiveChildren: 1, maxTotalChildren: 1, maxPendingMessages: 1, maxMessageBytes: 4096 },
  maxParallelChildren: 1,
  enabled: true,
} as const

function waitForFile(path: string, timeoutMs: number) {
  return Effect.tryPromise({
    try: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        const deadline = Date.now() + timeoutMs
        const inspect = () => {
          if (existsSync(path)) return resolvePromise()
          if (Date.now() >= deadline) return rejectPromise(new Error(`timed out waiting for ${path}`))
          setTimeout(inspect, 10)
        }
        inspect()
      }),
    catch: (error) => (error instanceof Error ? error : new Error("failed waiting for child readiness")),
  })
}

function hostCommandRunning(pattern: string) {
  const result = Bun.spawnSync(["pgrep", "-f", pattern])
  return result.exitCode === 0
}

function waitForHostCommand(pattern: string, timeoutMs: number) {
  return Effect.tryPromise({
    try: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        const deadline = Date.now() + timeoutMs
        const inspect = () => {
          if (hostCommandRunning(pattern)) return resolvePromise()
          if (Date.now() >= deadline) return rejectPromise(new Error(`timed out waiting for host process ${pattern}`))
          setTimeout(inspect, 10)
        }
        inspect()
      }),
    catch: (error) => (error instanceof Error ? error : new Error("failed waiting for host process")),
  })
}

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
async function withLiveHostKernel<T, R>(body: (context: LiveContext) => Effect.Effect<T, unknown, R>): Promise<T> {
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

    const program = Effect.scoped(
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
    ).pipe(
      Effect.provide(layer),
      Effect.provideService(TrustedPrincipalContext, { principal: { kind: "server_auth", subject: "terminal-live-test" } }),
    )
    // The private fixture layer and explicit authenticated test principal above satisfy this live
    // adapter's complete environment before the test program reaches runPromise.
    return await Effect.runPromise(program as Effect.Effect<T, unknown, never>)
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
    // The live fixture uses one authenticated principal for registration and approval.
    yield* supervisor
      .replyGuardApproval({ approvalID: request.approvalID, decision })
      .pipe(Effect.provideService(TrustedPrincipalContext, { principal: { kind: "server_auth", subject: "terminal-live-test" } }))
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
      .pipe(Effect.provideService(TrustedPrincipalContext, { principal: { kind: "server_auth", subject: "terminal-live-test" } }))
  })

test("direct child Attempt scope survives Core prepare, atomic bind and consume as u64 MessagePack", async () => {
  await withLiveHostKernel(({ supervisor, workspace }) =>
    Effect.gen(function* () {
      const workspaceID = "wrk_live_direct_attempt"
      const childSessionID = "ses_live_direct_child"
      const parentSessionID = "ses_live_direct_parent"
      const attemptID = "att_live0123456789ab"
      const locationRef = Location.Ref.make({
        directory: AbsolutePath.make(workspace),
        workspaceID: WorkspaceV2.ID.make(workspaceID),
      })
      const locationID = yield* supervisor.registerHostLocation(locationRef)
      const sha = (letter: string) => `sha256:${letter.repeat(64)}`
      const admitted = yield* supervisor.requestHostKernel("managed.v1", "admit_direct_attempt", {
        attemptID,
        parentSessionID,
        childSessionID,
        agent: "Reader",
        profileSelection: { profileId: "specialist.reader", revision: "1" },
        profileDefinition: directProfileDefinition,
        scopeDigest: sha("a"),
        locationID,
        workspaceID,
        capabilityDigest: sha("b"),
        permissionsDigest: sha("c"),
        budgetDigest: sha("d"),
      }, { deliveryID: attemptID })
      const rawScope = admitted.directAttempt
      expect(typeof rawScope).toBe("object")
      if (typeof rawScope !== "object" || rawScope === null) throw new Error("missing admitted directAttempt")
      const fields = rawScope as Record<string, unknown>
      if (typeof fields.ownerEpoch !== "string" && typeof fields.ownerEpoch !== "number" && typeof fields.ownerEpoch !== "bigint") {
        throw new Error("admitted directAttempt has invalid owner epoch")
      }
      if (typeof fields.expectedRevision !== "string" && typeof fields.expectedRevision !== "number" && typeof fields.expectedRevision !== "bigint") {
        throw new Error("admitted directAttempt has invalid expected revision")
      }
      const directAttempt = {
        ...fields,
        ownerEpoch: String(fields.ownerEpoch),
        expectedRevision: String(fields.expectedRevision),
      } as DirectAttemptScopeV1

      const approvals: Queue.Queue<GuardApprovalRequest> = yield* Queue.unbounded<GuardApprovalRequest>()
      const listener = yield* Effect.forkScoped(
        Effect.gen(function* () {
          const events = yield* EventV2.Service
          yield* events.listen((event) => {
            if (event.type === GuardApprovalRequested.type) {
              Queue.offerUnsafe(approvals, event.data as GuardApprovalRequest)
            }
            return Effect.void
          })
        }),
      )
      const reply = yield* Effect.forkScoped(
        Effect.gen(function* () {
          const request = yield* Queue.take(approvals)
          expect(request.capabilityID).toBe("files.write")
          yield* supervisor
            .replyGuardApproval({ approvalID: request.approvalID, decision: "allow_once" })
            .pipe(Effect.provideService(TrustedPrincipalContext, { principal: { kind: "server_auth", subject: "terminal-live-test" } }))
        }),
      )
      const batchID = "batch_direct_attempt_wire"
      const admission = yield* supervisor.prepareToolBatch({
        sessionID: childSessionID,
        locationRef,
        batchID,
        turnContextDigest: sha("f"),
        directAttempt,
        calls: [{
          callID: "call_direct_attempt_wire",
          capabilityID: "files.write",
          arguments: { path: "child-effect.txt", content: "guarded child effect" },
        }],
      })
      expect(admission.status).toBe("prepared")
      if (admission.status !== "prepared") throw new Error("expected a prepared direct child write")
      yield* Fiber.join(reply)

      const bound = yield* supervisor.requestHostKernel("managed.v1", "bind_direct_attempt_effects", {
        attemptID,
        locationID,
        sessionID: childSessionID,
        effectIDs: [admission.lease.effectID],
        directAttempt: directAttemptScopeToWire(directAttempt),
      }, { deliveryID: `${attemptID}.bind.1` })
      expect(bound.status).toBe("BOUND")
      expect(bound.effectIDs).toEqual([admission.lease.effectID])

      const receipt = yield* supervisor.executeWrite({
        sessionID: childSessionID,
        locationRef,
        lease: admission.lease,
        content: "guarded child effect",
        directAttempt,
        trustedPrincipal: { kind: "server_auth", subject: "terminal-live-test" },
      })
      expect(receipt.effectID).toBe(admission.lease.effectID)
      expect(receipt.receiptDigest).toMatch(/^blake3:[0-9a-f]{64}$/)
      expect(receipt.resource).toBe("child-effect.txt")
      yield* Fiber.interrupt(listener)
    }),
  )
}, 30_000)

test("Core forwards stale direct Attempt revision and HostKernel denies before Guard admission", async () => {
  await withLiveHostKernel(({ supervisor, workspace }) =>
    Effect.gen(function* () {
      const workspaceID = "wrk_live_direct_stale"
      const childSessionID = "ses_live_direct_stale_child"
      const parentSessionID = "ses_live_direct_stale_parent"
      const attemptID = "att_livestale012345678"
      const locationRef = Location.Ref.make({
        directory: AbsolutePath.make(workspace),
        workspaceID: WorkspaceV2.ID.make(workspaceID),
      })
      const locationID = yield* supervisor.registerHostLocation(locationRef)
      const sha = (letter: string) => `sha256:${letter.repeat(64)}`
      const admitted = yield* supervisor.requestHostKernel("managed.v1", "admit_direct_attempt", {
        attemptID,
        parentSessionID,
        childSessionID,
        agent: "Reader",
        profileSelection: { profileId: "specialist.reader", revision: "1" },
        profileDefinition: directProfileDefinition,
        scopeDigest: sha("a"),
        locationID,
        workspaceID,
        capabilityDigest: sha("b"),
        permissionsDigest: sha("c"),
        budgetDigest: sha("d"),
      }, { deliveryID: attemptID })
      const rawScope = admitted.directAttempt
      if (typeof rawScope !== "object" || rawScope === null) throw new Error("missing admitted directAttempt")
      const fields = rawScope as Record<string, unknown>
      if (typeof fields.ownerEpoch !== "string" && typeof fields.ownerEpoch !== "number" && typeof fields.ownerEpoch !== "bigint") {
        throw new Error("admitted directAttempt has invalid owner epoch")
      }
      const scope = {
        ...fields,
        ownerEpoch: String(fields.ownerEpoch),
        expectedRevision: "2",
      } as DirectAttemptScopeV1
      const exit = yield* Effect.exit(
        supervisor.requestHostKernel("effects.v2", "prepare_tool_batch", {
          sessionID: childSessionID,
          locationID,
          batchID: "batch_direct_attempt_stale_revision",
          turnContextDigest: sha("f"),
          directAttempt: directAttemptScopeToWire(scope),
          calls: [{
            callID: "call_stale_scope",
            capabilityID: "files.write",
            arguments: { path: "must-not-write.txt", content: "denied" },
          }],
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.squash(exit.cause)
        expect(failure).toBeInstanceOf(Error)
        expect(String(failure)).toContain("Attempt revision changed")
      }
      expect(existsSync(join(workspace, "must-not-write.txt"))).toBe(false)
    }),
  )
}, 30_000)

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
    expect(outcome.result.artifactFidelity).toBe("FULL")
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
    expect(["FULL", "SAMPLE", "FAILED"]).toContain(outcome.result.artifactFidelity)
    expect(outcome.result.artifactRef.length).toBeGreaterThan(0)
    expect(outcome.result.receiptRef.length).toBeGreaterThan(0)
    expect(outcome.marker).toBe(true)
  }, 60000)

  test("a terminal.run lasting longer than the generic RPC timeout returns its observed result", async () => {
    const outcome = await withLiveHostKernel(({ supervisor, pty, approvals, workspace, locationRef }) =>
      Effect.gen(function* () {
        const marker = join(workspace, "long-run-completed")
        const responder = yield* Effect.forkChild(replyWhenRequested(approvals, supervisor, "allow_once"))
        const prepared = yield* pty.prepareToolBatch({
          sessionID,
          locationRef,
          batchID: "batch_terminal_long_run",
          turnContextDigest,
          calls: [
            {
              callID: "call_terminal_long_run",
              capabilityID: "terminal.run",
              arguments: {
                command: `sleep 31; touch '${marker}'`,
                cwd: workspace,
                timeoutMs: 45_000,
              },
            },
          ],
        })
        yield* Fiber.join(responder)
        if (prepared.admission.status !== "prepared") {
          return yield* Effect.die(new Error(`long run was not prepared: ${JSON.stringify(prepared.admission)}`))
        }
        const result = yield* pty.runTool({
          sessionID,
          locationRef,
          lease: prepared.admission.lease,
          call: prepared.calls[0]!,
        })
        return { result, marker: existsSync(marker) }
      }),
    )

    expect(outcome.result.status).toBe("exited")
    expect(outcome.result.exitCode).toBe(0)
    expect(outcome.marker).toBe(true)
  }, 90000)

  test("interrupting an admitted terminal.run terminates the child and settles its receipt", async () => {
    const outcome = await withLiveHostKernel(({ supervisor, pty, approvals, workspace, locationRef }) =>
      Effect.gen(function* () {
        const started = join(workspace, "cancel-run-started")
        const completed = join(workspace, "cancel-run-completed")
        const processMarker = `hzcode-p1-cancel-${randomUUID()}`
        const processPattern = `^${processMarker} 23$`
        const responder = yield* Effect.forkChild(replyWhenRequested(approvals, supervisor, "allow_once"))
        const prepared = yield* pty.prepareToolBatch({
          sessionID,
          locationRef,
          batchID: "batch_terminal_cancel",
          turnContextDigest,
          calls: [
            {
              callID: "call_terminal_cancel",
              capabilityID: "terminal.run",
              arguments: {
              command: `touch '${started}'; bash -c 'exec -a ${processMarker} sleep 23'; touch '${completed}'`,
                cwd: workspace,
                timeoutMs: 30_000,
              },
            },
          ],
        })
        yield* Fiber.join(responder)
        if (prepared.admission.status !== "prepared") {
          return yield* Effect.die(new Error(`cancelled batch was not prepared: ${JSON.stringify(prepared.admission)}`))
        }
        const lease = prepared.admission.lease

        const run = yield* pty
          .runTool({
            sessionID,
            locationRef,
            lease,
            call: prepared.calls[0]!,
          })
          .pipe(Effect.forkChild)
        return yield* Effect.gen(function* () {
          yield* waitForFile(started, 5_000)
          yield* waitForHostCommand(processPattern, 5_000)
          const processBeforeCancel = yield* Effect.sync(() => hostCommandRunning(processPattern))
          yield* Fiber.interrupt(run)

          const locationID = yield* supervisor.registerHostLocation(locationRef)
          const settled = yield* supervisor.requestHostKernel("effects.v2", "reconcile_effect", {
            effectID: lease.effectID,
            locationID,
            sessionID,
          })
          const processAfterCancel = yield* Effect.sync(() => hostCommandRunning(processPattern))
          return {
            completed: existsSync(completed),
            processBeforeCancel,
            processAfterCancel,
            settledStatus: settled.status,
            receiptDigest: settled.receiptDigest,
          }
        }).pipe(Effect.ensuring(Fiber.interrupt(run)))
      }),
    )

    expect(outcome.completed).toBe(false)
    expect(outcome.processBeforeCancel).toBe(true)
    expect(outcome.processAfterCancel).toBe(false)
    expect(outcome.settledStatus).toBe("settled")
    expect(String(outcome.receiptDigest)).toMatch(/^blake3:[0-9a-f]{64}$/)
  }, 90000)

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

  test("a run past its deadline settles timed_out and terminal.cancel cannot target a one-shot run", async () => {
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
        // `terminal.cancel` is interactive-terminal control; this one-shot run has no
        // active terminal session and has already settled at its deadline.
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
    // session, so the host refuses this unrelated control after the run settled.
    expect(Exit.isFailure(outcome.cancel)).toBe(true)
    expect(JSON.stringify(outcome.cancel)).toContain("terminal session is unavailable")
  }, 90000)

  test("a missing registered executable fails confinement preflight before admission", async () => {
    const outcome = await withLiveHostKernel(({ supervisor, workspace, locationRef }) =>
      Effect.gen(function* () {
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
        yield* Effect.sync(() => rmSync(probeExecutable))
        const prepare = yield* Effect.exit(
          supervisor.requestHostKernel("effects.v2", "prepare_tool_batch", {
            sessionID,
            locationID,
            batchID: "batch_missing_registered_shell",
            turnContextDigest,
            calls: [
              {
                callID: "call_missing_registered_shell",
                capabilityID: "terminal.run",
                arguments: {
                  shellProfileID: shellProfile,
                  command: "printf 'MUST_NOT_RUN\\n'",
                  cwd: workspace,
                  timeoutMs: 30_000,
                  resolvedEnvironment,
                },
              },
            ],
          }),
        )
        return { prepare }
      }),
    )

    expect(Exit.isFailure(outcome.prepare)).toBe(true)
    if (Exit.isFailure(outcome.prepare)) {
      expect(Cause.prettyErrors(outcome.prepare.cause).map((error) => error.message).join("\n")).toContain(
        "terminal confinement is unavailable; no effect was admitted",
      )
    }
  })

  test("an observed nonzero shell exit settles as a known failure and cannot retry", async () => {
    const outcome = await withLiveHostKernel(({ supervisor, workspace, locationRef }) =>
      Effect.gen(function* () {
        // Use a workspace-local shell so the confined backend resolves the exact
        // executable. A missing executable is correctly rejected during preflight,
        // before durable dispatch; this case instead verifies an observed child failure.
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
        const withdrawn = yield* dispatch("withdrawn", "exit 7")
        return { healthy, withdrawn }
      }),
    )

    // The probe backend really is the run's backend while it exists.
    expect(Exit.isSuccess(outcome.healthy.result)).toBe(true)
    expect(outcome.healthy.resultMessage).toBe("")

    // The observed nonzero child exit is a known process outcome, so Guard stores a
    // receipt and reconciliation returns SETTLED. UNKNOWN is reserved for a lost or
    // unobserved process outcome, covered by the HostKernel restart/recovery matrix.
    expect(Exit.isSuccess(outcome.withdrawn.result)).toBe(true)
    if (Exit.isFailure(outcome.withdrawn.result)) throw new Error(outcome.withdrawn.resultMessage)
    const failedRun = outcome.withdrawn.result.value as Record<string, unknown>
    expect(failedRun.status).toBe("exited")
    expect(failedRun.exitCode).toBe(7)
    expect(failedRun.preview).toBe("")
    expect(failedRun.receiptRef).toMatch(/^blake3:[0-9a-f]{64}$/)
    expect(Exit.isSuccess(outcome.withdrawn.reconcile)).toBe(true)
    if (Exit.isFailure(outcome.withdrawn.reconcile)) throw new Error(outcome.withdrawn.reconcileMessage)
    const reconciled = outcome.withdrawn.reconcile.value as Record<string, unknown>
    expect(reconciled.status).toBe("settled")
    expect(reconciled.receiptDigest).toMatch(/^blake3:[0-9a-f]{64}$/)
    expect(outcome.withdrawn.replayMessage).toBe(
      "Session supervisor effect failed: capability lease is missing or consumed",
    )
  }, 90000)

  test("Core user-origin terminal.run requires approval without fabricating a Session", async () => {
    const outcome = await withLiveHostKernel(({ supervisor, pty, approvals, workspace, locationRef }) =>
      Effect.gen(function* () {
        const principal = { principal: { kind: "server_auth" as const, subject: "terminal-live-test" } }
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

  test("provider-turn interruption cancels a blocked Core approval at the real host", async () => {
    const outcome = await withLiveHostKernel(({ supervisor, approvals, workspace, locationRef }) =>
      Effect.gen(function* () {
        const controller = new AbortController()
        const batchID = "batch_provider_cancel"
        const target = join(workspace, "provider-cancelled.txt")
        const preparation = Effect.runPromise(
          supervisor.prepareToolBatch({
            sessionID,
            locationRef,
            batchID,
            turnContextDigest,
            calls: [
              {
                callID: "call_provider_cancel",
                capabilityID: "files.write",
                arguments: { path: target, content: "must-not-write" },
              },
            ],
          }).pipe(
            Effect.provideService(TrustedPrincipalContext, {
              principal: { kind: "server_auth", subject: "terminal-live-test" },
            }),
          ),
          { signal: controller.signal },
        ).then(
          () => "prepared" as const,
          () => "interrupted" as const,
        )

        const approval = yield* Queue.take(approvals)
        expect(approval.capabilityID).toBe("files.write")
        expect(approval.sessionID).toBe(sessionID)
        controller.abort(new Error("provider turn cancelled"))
        const preparationStatus = yield* Effect.promise(() => preparation)

        const locationID = yield* supervisor.registerHostLocation(locationRef)
        const cancelled = yield* supervisor.requestHostKernel("effects.v2", "cancel_batch", {
          locationID,
          sessionID,
          batchID,
        })
        const lateHostApproval = yield* Effect.exit(
          supervisor.requestHostKernel("effects.v2", "resolve_approval", {
            challengeID: approval.challengeID,
            decision: "allow_once",
          }),
        )
        const lateCoreReply = yield* Effect.exit(
          supervisor
            .replyGuardApproval({ approvalID: approval.approvalID, decision: "allow_once" })
            .pipe(Effect.provideService(TrustedPrincipalContext, { principal: { kind: "server_auth", subject: "terminal-live-test" } })),
        )

        return {
          preparationStatus,
          cancelled,
          lateHostApproval,
          lateCoreReply,
          targetExists: existsSync(target),
        }
      }),
    )

    expect(outcome.preparationStatus).toBe("interrupted")
    expect(outcome.cancelled).toMatchObject({
      status: "cancelled",
      batchId: "batch_provider_cancel",
      cancelled: 1,
      prepared: 0,
    })
    expect(Exit.isFailure(outcome.lateHostApproval)).toBe(true)
    expect(Exit.isFailure(outcome.lateCoreReply)).toBe(true)
    expect(outcome.targetExists).toBe(false)
  }, 60000)

  test("provider-turn interruption cancels an approved but unexecuted batch at the real host", async () => {
    const outcome = await withLiveHostKernel(({ supervisor, approvals, workspace, locationRef }) =>
      Effect.gen(function* () {
        const controller = new AbortController()
        const batchID = "batch_provider_cancel_approved"
        const target = join(workspace, "provider-cancelled-approved.txt")
        const preparation = Effect.runPromise(
          supervisor.prepareToolBatch({
            sessionID,
            locationRef,
            batchID,
            turnContextDigest,
            calls: [
              {
                callID: "call_provider_cancel_approved",
                capabilityID: "files.write",
                arguments: { path: target, content: "must-not-write" },
              },
            ],
          }).pipe(
            Effect.provideService(TrustedPrincipalContext, {
              principal: { kind: "server_auth", subject: "terminal-live-test" },
            }),
          ),
          { signal: controller.signal },
        ).then(
          () => "prepared" as const,
          () => "interrupted" as const,
        )

        const approval = yield* Queue.take(approvals)
        expect(approval.capabilityID).toBe("files.write")
        const locationID = yield* supervisor.registerHostLocation(locationRef)
        const approved = yield* supervisor.requestHostKernel("effects.v2", "resolve_approval", {
          challengeID: approval.challengeID,
          decision: "allow_once",
        })
        controller.abort(new Error("provider turn cancelled after host approval"))
        const preparationStatus = yield* Effect.promise(() => preparation)
        const cancelled = yield* supervisor.requestHostKernel("effects.v2", "cancel_batch", {
          locationID,
          sessionID,
          batchID,
        })
        const lateExecute = yield* Effect.exit(
          supervisor.requestHostKernel("effects.v2", "execute_write", {
            sessionID,
            locationID,
            effectID: approved.effectID,
            capabilityLeaseDigest: approved.capabilityLeaseDigest,
            content: "must-not-write",
          }),
        )
        const lateHostApproval = yield* Effect.exit(
          supervisor.requestHostKernel("effects.v2", "resolve_approval", {
            challengeID: approval.challengeID,
            decision: "allow_once",
          }),
        )
        const lateCoreReply = yield* Effect.exit(
          supervisor
            .replyGuardApproval({ approvalID: approval.approvalID, decision: "allow_once" })
            .pipe(Effect.provideService(TrustedPrincipalContext, { principal: { kind: "server_auth", subject: "terminal-live-test" } })),
        )

        return {
          approved,
          preparationStatus,
          cancelled,
          lateExecute,
          lateHostApproval,
          lateCoreReply,
          targetExists: existsSync(target),
        }
      }),
    )

    expect(outcome.approved.status).toBe("approved")
    expect(outcome.preparationStatus).toBe("interrupted")
    expect(outcome.cancelled).toMatchObject({
      status: "cancelled",
      batchId: "batch_provider_cancel_approved",
      cancelled: 1,
      prepared: 0,
    })
    expect(Exit.isFailure(outcome.lateExecute)).toBe(true)
    expect(Exit.isFailure(outcome.lateHostApproval)).toBe(true)
    expect(Exit.isFailure(outcome.lateCoreReply)).toBe(true)
    expect(outcome.targetExists).toBe(false)
  }, 60000)
})
