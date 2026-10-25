import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import { Cause, Effect, Exit, Option, Stream } from "effect"
import {
  assertApplicationFrameFence,
  OPTIONAL_HOST_FEATURES,
  sessionSupervisorArgs,
  validateManagedVerifierChallenges,
  collectManagedVerifierApprovalDecisions,
  waitForSocket,
  withApplicationFrameFence,
  type ManagedVerifierGuardChallengeV1,
} from "@opencode-ai/core/session/supervisor"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"

const base = {
  source: "/var/lib/opencode/state.db",
  stateDirectory: "/var/lib/opencode/state/ses_test",
  socketPath: "/var/lib/opencode/state/ses_test/s-0123456789abcdef.sock",
  hostExecutable: "/usr/bin/bun",
  sessionID: "ses_test",
  nonce: "0123456789abcdef0123456789abcdef",
  incarnation: "fedcba9876543210fedcba9876543210",
  ownerEpoch: 7,
} as const

describe("session_supervisor launch arguments", () => {
  test("offers resource-policy ingress only as an optional negotiated host feature", () => {
    expect(OPTIONAL_HOST_FEATURES).toContain("resource-policy.ingress-v1")
  })

  test("offers read-context only as an optional negotiated host feature", () => {
    expect(OPTIONAL_HOST_FEATURES).toContain("repo-intel.read-context-v1")
    expect(OPTIONAL_HOST_FEATURES).not.toContain("repo-intel.read-context-v1-required")
  })

  test("offers managed ArtifactStore reads only as an optional negotiated host feature", () => {
    expect(OPTIONAL_HOST_FEATURES).toContain("artifact.read-context-v1")
    expect(OPTIONAL_HOST_FEATURES).not.toContain("artifact.read-context-v1-required")
  })

  test("passes the host kernel owner epoch and the exact accepted argument set", () => {
    const args = sessionSupervisorArgs(base)

    expect(args).toEqual([
      `--source=${base.source}`,
      `--state-dir=${base.stateDirectory}`,
      `--socket=${base.socketPath}`,
      `--host-exe=${base.hostExecutable}`,
      `--session=${base.sessionID}`,
      `--nonce=${base.nonce}`,
      `--incarnation=${base.incarnation}`,
      "--owner-epoch=7",
    ])
    expect(args.some((arg) => arg.startsWith("--workspace-root="))).toBe(false)
  })

  test("rejects a missing, zero, fractional, or unsafe owner epoch", () => {
    for (const ownerEpoch of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => sessionSupervisorArgs({ ...base, ownerEpoch })).toThrow()
    }
  })

  test("rejects a relative launch path", () => {
    expect(() => sessionSupervisorArgs({ ...base, source: "state.db" })).toThrow()
    expect(() => sessionSupervisorArgs({ ...base, socketPath: "s.sock" })).toThrow()
  })
})

describe("session supervisor socket startup", () => {
  test("waits for the bound socket inode to receive owner-only permissions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hc-supervisor-socket-race-"))
    const path = join(directory, "supervisor.sock")
    const server = createServer()
    try {
      await new Promise<void>((resolve) => server.listen(path, resolve))
      const child = { isRunning: Effect.succeed(true) } as unknown as ChildProcessHandle
      const secure = waitForSocket(path, child, new AbortController().signal, 1_000)
      setTimeout(() => chmodSync(path, 0o600), 40)
      await secure
    } finally {
      server.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("rejects a same-owner socket that stays accessible to group or other", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hc-supervisor-socket-insecure-"))
    const path = join(directory, "supervisor.sock")
    const server = createServer()
    try {
      await new Promise<void>((resolve) => server.listen(path, resolve))
      const child = { isRunning: Effect.succeed(true) } as unknown as ChildProcessHandle
      await expect(
        waitForSocket(path, child, new AbortController().signal, 1_000),
      ).rejects.toThrow("permissions or owner are invalid")
    } finally {
      server.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("supervisor application frame fencing", () => {
  const fence = { ownerEpoch: 7, processIncarnation: "inc-1" } as const
  const request = { kind: "request", protocol: 1, requestId: "req_1" }

  test("binds outbound application frames to the negotiated epoch and incarnation", () => {
    expect(withApplicationFrameFence(request, fence)).toEqual({
      ...request,
      ownerEpoch: fence.ownerEpoch,
      processIncarnation: fence.processIncarnation,
    })
    expect(
      withApplicationFrameFence({ kind: "ack", subscriptionId: "sub_1" }, fence),
    ).toMatchObject({
      ownerEpoch: fence.ownerEpoch,
      processIncarnation: fence.processIncarnation,
    })
    for (const kind of [
      "response",
      "event",
      "subscribe",
      "unsubscribe",
      "page_end",
      "resnapshot_required",
      "cancel_request",
      "ping",
    ]) {
      expect(withApplicationFrameFence({ kind }, fence)).toMatchObject({
        ownerEpoch: fence.ownerEpoch,
        processIncarnation: fence.processIncarnation,
      })
    }
  })

  test("rejects caller-supplied fencing that differs from the negotiated fence", () => {
    expect(() => withApplicationFrameFence({ ...request, ownerEpoch: 8 }, fence)).toThrow()
    expect(() =>
      withApplicationFrameFence({ ...request, processIncarnation: "inc-2" }, fence),
    ).toThrow()
  })

  test("requires exact fencing on inbound application frames", () => {
    expect(() =>
      assertApplicationFrameFence({ ...request, ownerEpoch: 7 }, fence),
    ).toThrow()
    expect(() =>
      assertApplicationFrameFence(
        { ...request, ownerEpoch: 7, processIncarnation: "inc-2" },
        fence,
      ),
    ).toThrow()
    expect(() =>
      assertApplicationFrameFence(
        { ...request, ownerEpoch: 7, processIncarnation: "inc-1" },
        fence,
      ),
    ).not.toThrow()
  })

  test("rejects invalid negotiated fences and non-application frames", () => {
    for (const ownerEpoch of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        withApplicationFrameFence(request, { ownerEpoch, processIncarnation: "inc-1" }),
      ).toThrow()
    }
    for (const processIncarnation of ["", "nul\0", "x".repeat(257)]) {
      expect(() =>
        withApplicationFrameFence(request, { ownerEpoch: 7, processIncarnation }),
      ).toThrow()
    }
    expect(
      withApplicationFrameFence(request, { ownerEpoch: 7, processIncarnation: "é".repeat(128) }),
    ).toMatchObject({ ownerEpoch: 7 })
    expect(() => withApplicationFrameFence({ kind: "hello" }, fence)).toThrow()
  })
})

describe("managed verifier approval challenge bounds", () => {
  const challenge = (index: number): ManagedVerifierGuardChallengeV1 => ({
    challengeID: `challenge-${index}`,
    effectID: `effect-${index}`,
    capabilityID: "builtin.verifier",
    locationID: `loc_${"a".repeat(64)}`,
    inputDigest: `blake3:${"b".repeat(64)}`,
    normalizedTargets: [{ action: "run", criterion: `criterion-${index}` }],
    expiresAtUnixMs: Date.now() + 60_000,
    policySummary: "Run the host-registered verifier for one accepted criterion.",
    origin: "managed_run",
    source: "host.managed_verifier",
    policyID: "builtin.verifier.v1",
    policyDigest: `blake3:${"c".repeat(64)}`,
    normalizedAction: "builtin.verifier",
    argumentSummary: { status: "available", text: "Run the host-selected verifier" },
    requestedGuarantees: ["no_symlink"],
    // Verifier challenges are always fail-closed: the reviewer decides, so the host
    // must never pre-assess guarantees or pre-enable allow for the consent projection.
    guaranteeAssessment: { status: "not_assessed", residual: null },
    runID: `run-${index}`,
    noResponse: "deny_and_expire",
    allowEnabled: false,
  })

  test("accepts one complete bounded set for the registered location", () => {
    expect(validateManagedVerifierChallenges(`loc_${"a".repeat(64)}`, [challenge(1)])).toHaveLength(1)
  })

  test("rejects a challenge set larger than the managed criteria bound before publishing", () => {
    expect(() =>
      validateManagedVerifierChallenges(
        `loc_${"a".repeat(64)}`,
        Array.from({ length: 33 }, (_, index) => challenge(index + 1)),
      ),
    ).toThrow("exceeds the managed criteria bound")
  })

  test("rejects a challenge bound to another Location or a duplicate effect", () => {
    const wrongLocation = { ...challenge(1), locationID: `loc_${"c".repeat(64)}` }
    expect(() => validateManagedVerifierChallenges(challenge(1).locationID, [wrongLocation])).toThrow(
      "registered Location",
    )
    const duplicateEffect = { ...challenge(2), effectID: challenge(1).effectID }
    expect(() =>
      validateManagedVerifierChallenges(challenge(1).locationID, [challenge(1), duplicateEffect]),
    ).toThrow("duplicate")
  })

  test("returns only observed partial decisions when a later approval window fails", async () => {
    const observed: string[] = []
    const result = await Effect.runPromise(
      collectManagedVerifierApprovalDecisions(
        Array.from({ length: 18 }, (_, index) => challenge(index + 1)),
        (item) => {
          observed.push(item.challengeID)
          if (item.challengeID === "challenge-17") return Effect.fail(new Error("socket closed"))
          return Effect.succeed("allow_once" as const)
        },
      ),
    )

    expect(result).toEqual({
      kind: "abort",
      reason: "transport_lost",
      decisions: Array.from({ length: 16 }, (_, index) => ({
        challengeID: `challenge-${index + 1}`,
        decision: "allow_once",
      })),
    })
    expect(observed).toEqual(Array.from({ length: 17 }, (_, index) => `challenge-${index + 1}`))
  })

  test("stops after a genuine denial without inventing decisions for unseen challenges", async () => {
    const result = await Effect.runPromise(
      collectManagedVerifierApprovalDecisions(
        [challenge(1), challenge(2), challenge(3)],
        (item) => Effect.succeed(item.challengeID === "challenge-2" ? "deny" as const : "allow_once" as const),
      ),
    )

    expect(result).toEqual({
      kind: "abort",
      reason: "reviewer_denied",
      decisions: [
        { challengeID: "challenge-1", decision: "allow_once" },
        { challengeID: "challenge-2", decision: "deny" },
      ],
    })
  })
})

describe("session_supervisor startup failure diagnostics", () => {
  const encoder = new TextEncoder()

  /**
   * A child that has already died. `waitForSocket` only ever consults the exit
   * status and stderr on the paths where `isRunning` is false, which is exactly
   * the `Session supervisor startup failed` case the E2E run hit with no
   * explanation of why the child exited.
   */
  const exitedChild = (exitCode: number, stderr: string) =>
    ({
      isRunning: Effect.succeed(false),
      exitCode: Effect.succeed(exitCode),
      stderr: Stream.fromIterable([encoder.encode(stderr)]),
    }) as unknown as ChildProcessHandle

  const failure = (child: ChildProcessHandle, path: string) =>
    waitForSocket(path, child, new AbortController().signal, 1_000).then(
      () => undefined,
      (error: unknown) => String(error),
    )

  test("reports exit status and stderr when the child exits before binding its socket", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hc-supervisor-startup-"))
    // The socket is never created, so `lstatSync` fails and the child-death
    // branch of `waitForSocket` is the one that reports.
    const path = join(directory, "host-0123456789abcdef.sock")
    try {
      const message = await failure(
        exitedChild(7, "hz-kernel: InsecureDirectory lease check failed\n"),
        path,
      )
      expect(message).toContain("exited before binding its socket")
      // Both of these are absent before the fix: a startup failure that hides
      // why the child exited is a diagnosability defect on its own.
      expect(message).toContain("exit code 7")
      expect(message).toContain("InsecureDirectory lease check failed")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("reports exit status and stderr when the child exits before securing its socket", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hc-supervisor-socket-unsecured-"))
    const path = join(directory, "supervisor.sock")
    const server = createServer()
    try {
      await new Promise<void>((resolve) => server.listen(path, resolve))
      const message = await failure(
        exitedChild(2, "supervisor.lock must be 0600 (UnsafeFile)\n"),
        path,
      )
      expect(message).toContain("exited before securing its socket")
      expect(message).toContain("exit code 2")
      expect(message).toContain("UnsafeFile")
    } finally {
      server.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
