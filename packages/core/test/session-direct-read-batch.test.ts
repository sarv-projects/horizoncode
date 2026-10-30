import { describe, expect, test } from "bun:test"
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { encodeCanonicalMessagePackV1, Location } from "@horizoncode/schema"
import { Effect } from "effect"
import { TrustedPrincipalContext, type TrustedPrincipal } from "../src/trusted-principal"
import {
  DirectReadBatch,
  type DirectReadBatchRequestV1,
  type DirectReadHostV1,
  type DirectReadProjectionV1,
  type DirectReadPreparationV1,
} from "../src/session/direct-read-batch"

const sessionID = "ses_direct_read_batch"
const locationID = `loc_${"a".repeat(64)}`
const workspaceRevision = `blake3:${"c".repeat(64)}`
const policyDigest = `blake3:${"d".repeat(64)}`
const modeDigest = `blake3:${"e".repeat(64)}`
const workspaceBinding = `blake3:${"f".repeat(64)}`
const subjectBinding = `blake3:${"1".repeat(64)}`
const requestID = "rpc_read_1"

function call(callID: string, path = "src/app.ts", offset = 1, limit = 200) {
  return { callID, capabilityID: "files.read" as const, arguments: { path, offset, limit } }
}

function expectedArgumentsDigest(path: string, offset: number, limit: number) {
  return `blake3:${bytesToHex(blake3(encodeCanonicalMessagePackV1({ path, offset, limit })))}`
}

/**
 * Independent contract-shaped row builder (does not reuse the module's digest
 * helper) so a digest mismatch is a genuine cross-check, not a tautology.
 */
function row(input: {
  callID: string
  path?: string
  offset?: number
  limit?: number
  target?: string
  revision?: string
  overrides?: Record<string, unknown>
}) {
  const path = input.path ?? "src/app.ts"
  const offset = input.offset ?? 1
  const limit = input.limit ?? 200
  const binding = {
    argumentsDigest: expectedArgumentsDigest(path, offset, limit),
    callID: input.callID,
    capabilityID: "files.read",
    locationID,
    limit,
    offset,
    ownerEpoch: "7",
    policyDigest,
    permissionModeDigest: modeDigest,
    revision: input.revision ?? workspaceRevision,
    resultBudgetBytes: 51200,
    requestID,
    schemaVersion: 1,
    sessionID,
    subjectBinding,
    target: input.target ?? path,
    workspaceBinding,
  }
  const preimage = new Uint8Array([
    ...new TextEncoder().encode("horizoncode.direct-read-lease.v1\0"),
    ...encodeCanonicalMessagePackV1(binding),
  ])
  return { ...binding, readLeaseDigest: `blake3:${bytesToHex(blake3(preimage))}`, ...input.overrides }
}

function response(calls: ReadonlyArray<unknown>, revision = workspaceRevision) {
  return { schemaVersion: 1, workspaceRevision: revision, calls } as unknown as Readonly<Record<string, unknown>>
}

function request(calls: ReadonlyArray<ReturnType<typeof call>>): DirectReadBatchRequestV1 {
  return { schemaVersion: 1, sessionID, locationID, calls }
}

async function prepare(calls: ReadonlyArray<ReturnType<typeof call>>, body: unknown) {
  const sent: DirectReadBatchRequestV1[] = []
  const result = await Effect.runPromise(
    DirectReadBatch.prepare({
      sessionID,
      locationID,
      calls,
      requestID,
      send: (value) => {
        sent.push(value)
        return Effect.succeed(body as Readonly<Record<string, unknown>>)
      },
    }),
  )
  return { result, sent }
}

function expectFailure(
  result: { status: string; phase?: string; unknown?: boolean; replay?: string },
  phase: string,
  unknown = false,
) {
  expect(result.status).toBe("failed")
  expect(result.phase).toBe(phase)
  expect(result.unknown).toBe(unknown)
  expect(result.replay).toBe("forbidden")
}

describe("direct read batch local request validation", () => {
  test("accepts one to eight strict files.read calls and echoes the exact ordered body", async () => {
    const calls = [call("read-1"), call("read-2", "src/b.ts", 3, 400)]
    const { result, sent } = await prepare(
      calls,
      response([
        row({ callID: "read-1" }),
        row({ callID: "read-2", path: "src/b.ts", offset: 3, limit: 400 }),
      ]),
    )
    expect(result.status).toBe("prepared")
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({
      schemaVersion: 1,
      sessionID,
      locationID,
      calls: [
        { callID: "read-1", capabilityID: "files.read", arguments: { path: "src/app.ts", offset: 1, limit: 200 } },
        { callID: "read-2", capabilityID: "files.read", arguments: { path: "src/b.ts", offset: 3, limit: 400 } },
      ],
    })

    const eight = Array.from({ length: 8 }, (_, index) => call(`read-${index}`))
    const accepted = await prepare(eight, response(eight.map((item) => row({ callID: item.callID }))))
    expect(accepted.result.status).toBe("prepared")
  })

  test("accepts a canonical maximum-length path and recomputes its read digests", async () => {
    const longPath = "a".repeat(4096)
    const { result } = await prepare([call("read-1", longPath)], response([row({ callID: "read-1", path: longPath })]))
    expect(result.status).toBe("prepared")
  })

  test("rejects a malformed wave locally without sending a request", async () => {
    const cases: ReadonlyArray<ReadonlyArray<unknown>> = [
      [],
      Array.from({ length: 9 }, (_, index) => call(`read-${index}`)),
      [call("read-1"), call("read-1")],
      [{ callID: "read-1", capabilityID: "files.write", arguments: { path: "src/app.ts", offset: 1, limit: 1 } }],
      [{ callID: "read-1", capabilityID: "files.read", arguments: { path: "src/app.ts", offset: 1, limit: 1 }, extra: true }],
      [{ callID: "read-1", capabilityID: "files.read", arguments: { path: "src/app.ts", offset: 1, limit: 1, extra: 1 } }],
      [call("read-1", "/etc/passwd")],
      [call("read-1", "../secret.ts")],
      [call("read-1", "src//app.ts")],
      [call("read-1", "src/app.ts/")],
      [call("read-1", "src\\app.ts")],
      [call("read-1", "src/\u0000app.ts")],
      [call("read-1", "src/app.ts", 0, 200)],
      [call("read-1", "src/app.ts", 2001, 200)],
      [call("read-1", "src/app.ts", 1.5, 200)],
      [call("read-1", "src/app.ts", 1, 0)],
      [call("read-1", "src/app.ts", 1, 2001)],
      [call("read-1", "src/app.ts", 1, 2.5)],
    ]
    for (const calls of cases) {
      const { result, sent } = await prepare(calls as ReadonlyArray<ReturnType<typeof call>>, response([]))
      expectFailure(result, "request", false)
      expect(sent).toHaveLength(0)
    }
  })

  test("rejects an unauthenticated Session or Location identity locally", () => {
    const built = DirectReadBatch.buildRequest({
      sessionID: "not-a-session",
      locationID,
      calls: [call("read-1")],
    })
    expect(built.ok).toBe(false)
    const builtLocation = DirectReadBatch.buildRequest({
      sessionID,
      locationID: "loc_short",
      calls: [call("read-1")],
    })
    expect(builtLocation.ok).toBe(false)
  })
})

describe("direct read batch response substitution and whole-wave failure", () => {
  test("rejects missing, duplicate, extra, reordered and foreign rows", async () => {
    const calls = [call("read-1"), call("read-2")]
    const bodies = [
      response([]),
      response([row({ callID: "read-1" })]),
      response([row({ callID: "read-1" }), row({ callID: "read-1" })]),
      response([row({ callID: "read-1" }), row({ callID: "read-2" }), row({ callID: "read-3" })]),
      response([row({ callID: "read-2" }), row({ callID: "read-1" })]),
      response([row({ callID: "read-1" }), row({ callID: "foreign-9" })]),
      response([row({ callID: "read-1" }), { ...row({ callID: "read-2" }), extra: "x" }]),
      response([row({ callID: "read-1" }), row({ callID: "read-2", target: "src/other.ts" })]),
      response([row({ callID: "read-1" }), row({ callID: "read-2", offset: 9 })]),
      response([row({ callID: "read-1" }), row({ callID: "read-2", limit: 9 })]),
      response([row({ callID: "read-1" }), row({ callID: "read-2", overrides: { resultBudgetBytes: 65536 } })]),
      response([row({ callID: "read-1" }), row({ callID: "read-2", overrides: { ownerEpoch: "07" } })]),
      response([row({ callID: "read-1" }), row({ callID: "read-2", overrides: { policyDigest: "sha256:aa" } })]),
      response([row({ callID: "read-1" }), row({ callID: "read-2", overrides: { permissionModeDigest: "x" } })]),
      response([row({ callID: "read-1" }), row({ callID: "read-2", overrides: { subjectBinding: "x" } })]),
      response([row({ callID: "read-1" }), row({ callID: "read-2", overrides: { workspaceBinding: "x" } })]),
      response([row({ callID: "read-1" }), row({ callID: "read-2", overrides: { schemaVersion: 2 } })]),
      response([row({ callID: "read-1" }), { ...row({ callID: "read-2" }), locationID: `loc_${"b".repeat(64)}` }]),
      response([row({ callID: "read-1" }), { ...row({ callID: "read-2" }), capabilityID: "files.patch" }]),
      response([row({ callID: "read-1" }), row({ callID: "read-2", revision: `blake3:${"9".repeat(64)}` })]),
      response([row({ callID: "read-1" }), row({ callID: "read-2" })], `blake3:${"9".repeat(64)}`),
      response([row({ callID: "read-1" }), row({ callID: "read-2" })], "not-a-revision"),
      { schemaVersion: 2, workspaceRevision, calls: [row({ callID: "read-1" }), row({ callID: "read-2" })] },
      { schemaVersion: 1, workspaceRevision, calls: [row({ callID: "read-1" }), row({ callID: "read-2" })], extra: 1 },
      { schemaVersion: 1, workspaceRevision },
      null,
    ]
    for (const body of bodies) {
      const { result, sent } = await prepare(calls, body)
      expectFailure(result, "response", false)
      expect(sent).toHaveLength(1)
    }
  })

  test("rejects an out-of-request request identity on a row", async () => {
    const calls = [call("read-1")]
    const { result } = await prepare(calls, response([row({ callID: "read-1", overrides: { requestID: "rpc_other" } })]))
    expectFailure(result, "response", false)
  })

  test("recomputes both canonical digests and rejects substitution or tampering", async () => {
    const calls = [call("read-1")]
    const replacedArguments = { ...row({ callID: "read-1" }), argumentsDigest: expectedArgumentsDigest("src/app.ts", 1, 201) }
    expectFailure((await prepare(calls, response([replacedArguments]))).result, "response", false)

    const replacedLease = { ...row({ callID: "read-1" }), readLeaseDigest: `blake3:${"0".repeat(64)}` }
    expectFailure((await prepare(calls, response([replacedLease]))).result, "response", false)

    const movedPolicy = { ...row({ callID: "read-1" }), policyDigest: `blake3:${"3".repeat(64)}` }
    expectFailure((await prepare(calls, response([movedPolicy]))).result, "response", false)
  })

  test("classifies mixed read+effect and non-direct lanes away from the fast path", () => {
    const mixed = DirectReadBatch.classify({
      codeMode: false,
      lane: "direct_session",
      calls: [call("read-1"), { callID: "write-1", capabilityID: "files.write", arguments: {} }],
    })
    expect(mixed).toEqual({ kind: "not_direct_read", reason: "mixed_wave" })
    expect(DirectReadBatch.classify({ codeMode: true, lane: "direct_session", calls: [call("read-1")] }))
      .toEqual({ kind: "not_direct_read", reason: "code_mode" })
    expect(DirectReadBatch.classify({ codeMode: false, lane: "managed_attempt", calls: [call("read-1")] }))
      .toEqual({ kind: "not_direct_read", reason: "managed_lane" })
    expect(DirectReadBatch.classify({ codeMode: false, lane: "direct_attempt", calls: [call("read-1")] }))
      .toEqual({ kind: "not_direct_read", reason: "attempt_lane" })
    expect(DirectReadBatch.classify({
      codeMode: false,
      lane: "direct_session",
      parentSessionID: "ses_parent",
      calls: [call("read-1")],
    })).toEqual({ kind: "not_direct_read", reason: "child_lane" })
    const direct = DirectReadBatch.classify({ codeMode: false, lane: "direct_session", calls: [call("read-1")] })
    expect(direct.kind).toBe("direct_read")
  })
})

describe("direct read workspace fence and UNKNOWN semantics", () => {
  function prepared(overrides: Partial<DirectReadPreparationV1> = {}): DirectReadPreparationV1 {
    return {
      requestID,
      workspaceRevision,
      calls: [
        {
          schemaVersion: 1,
          requestID,
          sessionID,
          callID: "read-1",
          capabilityID: "files.read",
          locationID,
          target: "src/app.ts",
          offset: 1,
          limit: 200,
          argumentsDigest: expectedArgumentsDigest("src/app.ts", 1, 200),
          resultBudgetBytes: 51200,
          ownerEpoch: "7",
          policyDigest,
          permissionModeDigest: modeDigest,
          revision: workspaceRevision,
          workspaceBinding,
          subjectBinding,
          readLeaseDigest: `blake3:${"4".repeat(64)}`,
        } satisfies DirectReadProjectionV1,
      ],
      ...overrides,
    }
  }
  const snapshot = {
    sessionID,
    locationID,
    ownerEpoch: "7",
    workspaceRevision,
    workspaceRootDigest: `blake3:${"2".repeat(64)}`,
    observedAtUnixMs: "1712345678901",
  }

  test("accepts an unchanged authenticated workspace snapshot", () => {
    expect(DirectReadBatch.verifyFence({ prepared: prepared(), sessionID, locationID, snapshot })).toEqual({ ok: true })
  })

  test("fails the whole wave before publish on a missing or moved workspace fence", () => {
    const cases = [
      DirectReadBatch.verifyFence({ prepared: prepared(), sessionID, locationID, snapshot: undefined }),
      DirectReadBatch.verifyFence({
        prepared: prepared(),
        sessionID,
        locationID,
        snapshot: { ...snapshot, workspaceRevision: `blake3:${"9".repeat(64)}` },
      }),
      DirectReadBatch.verifyFence({ prepared: prepared(), sessionID, locationID, snapshot: { ...snapshot, sessionID: "ses_other" } }),
      DirectReadBatch.verifyFence({
        prepared: prepared(),
        sessionID,
        locationID,
        snapshot: { ...snapshot, locationID: `loc_${"b".repeat(64)}` },
      }),
      DirectReadBatch.verifyFence({
        prepared: prepared({
          calls: [{ ...prepared().calls[0]!, revision: `blake3:${"8".repeat(64)}` }],
        }),
        sessionID,
        locationID,
        snapshot,
      }),
    ]
    for (const result of cases) {
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected fence failure")
      expectFailure(result.failure, "fence", true)
    }
  })

  test("a possibly-sent admission failure is UNKNOWN-equivalent and never retried", async () => {
    let sends = 0
    const result = await Effect.runPromise(
      DirectReadBatch.prepare({
        sessionID,
        locationID,
        calls: [call("read-1")],
        requestID,
        send: () => {
          sends++
          return Effect.fail(new Error("transport closed after write"))
        },
      }),
    )
    expectFailure(result, "host", true)
    expect(sends).toBe(1)
    expect(result).not.toHaveProperty("calls")
  })
})

describe("direct read wave publication gate", () => {
  const snapshot = {
    sessionID,
    locationID,
    ownerEpoch: "7",
    workspaceRevision,
    workspaceRootDigest: `blake3:${"2".repeat(64)}`,
    observedAtUnixMs: "1712345678901",
  }
  const prepared: DirectReadPreparationV1 = {
    requestID,
    workspaceRevision,
    calls: ["read-1", "read-2"].map((callID) => ({
      schemaVersion: 1 as const,
      requestID,
      sessionID,
      callID,
      capabilityID: "files.read" as const,
      locationID,
      target: "src/app.ts",
      offset: 1,
      limit: 200,
      argumentsDigest: expectedArgumentsDigest("src/app.ts", 1, 200),
      resultBudgetBytes: 51200 as const,
      ownerEpoch: "7",
      policyDigest,
      permissionModeDigest: modeDigest,
      revision: workspaceRevision,
      workspaceBinding,
      subjectBinding,
      readLeaseDigest: `blake3:${"4".repeat(64)}`,
    })),
  }

  test("publishes only a complete, bounded, fenced wave", () => {
    const published = DirectReadBatch.publish({
      prepared,
      sessionID,
      locationID,
      snapshot,
      results: [
        { callID: "read-1", status: "settled", output: "hello" },
        { callID: "read-2", status: "settled", output: "x".repeat(51200) },
      ],
    })
    expect(published.ok).toBe(true)
    if (!published.ok) throw new Error("expected success")
    expect(published.calls.map((item) => item.callID)).toEqual(["read-1", "read-2"])
    expect(published.calls[1]!.bytes).toBe(51200)
  })

  test("fails the whole wave for oversize, foreign, missing or unsettled read results", () => {
    const cases = [
      {
        results: [
          { callID: "read-1", status: "settled", output: "x".repeat(51201) },
          { callID: "read-2", status: "settled", output: "ok" },
        ],
        unknown: false,
      },
      {
        results: [
          { callID: "read-2", status: "settled", output: "ok" },
          { callID: "read-1", status: "settled", output: "ok" },
        ],
        unknown: false,
      },
      {
        results: [{ callID: "read-1", status: "settled", output: "ok" }],
        unknown: false,
      },
      {
        results: [
          { callID: "read-1", status: "settled", output: "ok" },
          { callID: "read-2", status: "unknown" },
        ],
        unknown: true,
      },
      {
        results: [
          { callID: "read-1", status: "settled", output: "ok" },
          { callID: "read-2", status: "rejected" },
        ],
        unknown: false,
      },
    ] as const
    for (const item of cases) {
      const published = DirectReadBatch.publish({
        prepared,
        sessionID,
        locationID,
        snapshot,
        results: item.results as never,
      })
      expect(published.ok).toBe(false)
      if (published.ok) throw new Error("expected whole-wave failure")
      expect(published.failure.phase).toBe("result")
      expect(published.failure.unknown).toBe(item.unknown)
      expect(published.failure.replay).toBe("forbidden")
      expect(published.failure).not.toHaveProperty("calls")
    }
  })

  test("never publishes read results under a broken workspace fence", () => {
    const published = DirectReadBatch.publish({
      prepared,
      sessionID,
      locationID,
      snapshot: { ...snapshot, workspaceRevision: `blake3:${"9".repeat(64)}` },
      results: [
        { callID: "read-1", status: "settled", output: "hello" },
        { callID: "read-2", status: "settled", output: "hello" },
      ],
    })
    expect(published.ok).toBe(false)
    if (published.ok) throw new Error("expected fence failure")
    expect(published.failure.phase).toBe("fence")
    expect(published.failure.unknown).toBe(true)
  })
})

describe("direct read caller wave orchestration", () => {
  const locationRef = { directory: "/p7-fixture" } as unknown as Location.Ref
  const principal: TrustedPrincipal = { kind: "server_auth", subject: "p7-direct-read" }
  const snapshot = {
    sessionID,
    locationID,
    ownerEpoch: "7",
    workspaceRevision,
    workspaceRootDigest: `blake3:${"2".repeat(64)}`,
    observedAtUnixMs: "1712345678901",
  }

  type Log = string[]
  type Sent = {
    serviceID: string
    operation: string
    body: Readonly<Record<string, unknown>>
    options?: { trustedPrincipal?: TrustedPrincipal; authenticatedContext?: unknown }
  }

  function fixture(options: {
    readonly log: Log
    readonly enabled?: boolean
    readonly principal?: TrustedPrincipal
    readonly hostFail?: boolean
    readonly snapshotFail?: boolean
    readonly snapshotRevision?: string
    readonly body?: unknown
  }) {
    const sent: Sent[] = []
    const snapshots: string[] = []
    const host = {
      hostFeatureEnabled: (feature: string) =>
        Effect.sync(() => {
          options.log.push(`feature:${feature}`)
          return options.enabled ?? true
        }),
      registerHostLocation: () =>
        Effect.sync(() => {
          options.log.push("register")
          return locationID
        }),
      requestHostKernel: (
        serviceID: string,
        operation: string,
        body: Readonly<Record<string, unknown>>,
        request: Sent["options"],
      ) => {
        options.log.push("send")
        sent.push({ serviceID, operation, body, options: request })
        return options.hostFail
          ? Effect.fail(new Error("transport closed after write"))
          : Effect.succeed(
              (options.body ?? response([row({ callID: "read-1" })])) as Readonly<Record<string, unknown>>,
            )
      },
      directSessionWorkspaceSnapshot: (input: { readonly sessionID: string }) => {
        options.log.push("snapshot")
        snapshots.push(input.sessionID)
        if (options.snapshotFail) return Effect.fail(new Error("HostKernel snapshot unavailable"))
        return Effect.sync(() => ({ ...snapshot, workspaceRevision: options.snapshotRevision ?? workspaceRevision }))
      },
    } as unknown as DirectReadHostV1
    return { host, sent, snapshots }
  }

  function run(input: {
    readonly host: DirectReadHostV1
    readonly log?: Log
    readonly principal?: TrustedPrincipal
    /** The wave admits any capabilityID and rejects non-files.read members at classification. */
    readonly calls?: Parameters<typeof DirectReadBatch.classify>[0]["calls"]
    readonly lane?: "direct_session" | "managed_attempt" | "direct_attempt"
    readonly codeMode?: boolean
    readonly parentSessionID?: string
    readonly execute?: (
      projections: ReadonlyArray<DirectReadProjectionV1>,
    ) => Effect.Effect<ReadonlyArray<{ callID: string; status: "settled" | "rejected" | "cancelled" | "unknown"; output?: string }>, unknown>
    /** Call IDs the wave executed, in admitted order. */
    readonly executed?: string[]
  }) {
    const executed = input.executed ?? []
    return Effect.runPromise(
      DirectReadBatch.runWave({
        host: input.host,
        sessionID,
        locationRef,
        requestID,
        lane: input.lane ?? "direct_session",
        codeMode: input.codeMode ?? false,
        ...(input.parentSessionID === undefined ? {} : { parentSessionID: input.parentSessionID }),
        calls: input.calls ?? [call("read-1")],
        execute: (projections) => {
          input.log?.push("execute")
          executed.push(...projections.map((projection) => projection.callID))
          return input.execute
            ? input.execute(projections)
            : Effect.sync(() =>
                projections.map((projection) => ({ callID: projection.callID, status: "settled" as const, output: "ok" })),
              )
        },
      }).pipe(Effect.provideService(TrustedPrincipalContext, { principal: input.principal ?? principal })),
    ).then((outcome) => ({ outcome, executed }))
  }

  test("admits, executes and publishes one direct read wave in strict order", async () => {
    const log: Log = []
    const { host, sent } = fixture({ log })
    const { outcome, executed } = await run({ host, log })
    expect(log).toEqual(["feature:effects.v2", "register", "send", "execute", "snapshot"])
    expect(executed).toEqual(["read-1"])
    expect(sent).toHaveLength(1)
    expect(sent[0]!.serviceID).toBe("effects.v2")
    expect(sent[0]!.operation).toBe("prepare_tool_batch_read")
    expect(sent[0]!.body).toEqual({
      schemaVersion: 1,
      sessionID,
      locationID,
      calls: [{ callID: "read-1", capabilityID: "files.read", arguments: { path: "src/app.ts", offset: 1, limit: 200 } }],
    })
    expect(sent[0]!.options?.authenticatedContext).toEqual({ kind: "repo_read", sessionID, locationID })
    expect(sent[0]!.options?.trustedPrincipal).toEqual(principal)
    expect(outcome.status).toBe("published")
    if (outcome.status !== "published") throw new Error("expected a published wave")
    expect(outcome.calls.map((item) => item.callID)).toEqual(["read-1"])
  })

  test("keeps the ordinary path when the host feature is closed", async () => {
    const log: Log = []
    const { host, sent } = fixture({ log, enabled: false })
    const { outcome, executed } = await run({ host, log })
    expect(outcome).toEqual({ status: "unavailable" })
    expect(log).toEqual(["feature:effects.v2"])
    expect(sent).toHaveLength(0)
    expect(executed).toEqual([])
  })

  test("keeps the ordinary path for non-direct, CodeMode, child and mixed waves", async () => {
    const cases = [
      { input: { lane: "managed_attempt" as const } },
      { input: { lane: "direct_attempt" as const } },
      { input: { codeMode: true } },
      { input: { parentSessionID: "ses_child" } },
      { input: { calls: [call("read-1"), { callID: "write-1", capabilityID: "files.write", arguments: {} }] } },
    ]
    for (const item of cases) {
      const log: Log = []
      const { host, sent } = fixture({ log })
      const { outcome, executed } = await run({ host, log, ...item.input })
      expect(outcome).toEqual({ status: "unavailable" })
      expect(log).toEqual([])
      expect(sent).toHaveLength(0)
      expect(executed).toEqual([])
    }
  })

  test("denies the whole wave for a local body violation before any host interaction", async () => {
    const cases: ReadonlyArray<ReadonlyArray<unknown>> = [
      Array.from({ length: 9 }, (_, index) => call(`read-${index}`)),
      [call("read-1"), call("read-1")],
      [call("read-1", "/etc/passwd")],
      [call("read-1", "src/app.ts", 0, 200)],
      [call("read-1", "src/app.ts", 1, 2001)],
      [{ callID: "read-1", capabilityID: "files.read", arguments: { path: "src/app.ts", offset: 1, limit: 1, extra: 1 } }],
    ]
    for (const calls of cases) {
      const log: Log = []
      const { host, sent } = fixture({ log })
      const { outcome, executed } = await run({ host, log, calls: calls as ReadonlyArray<ReturnType<typeof call>> })
      expect(outcome.status).toBe("denied")
      if (outcome.status !== "denied") throw new Error("expected a denied wave")
      expect(outcome.failure.phase).toBe("request")
      expect(outcome.failure.replay).toBe("forbidden")
      expect(outcome).not.toHaveProperty("calls")
      expect(log).toEqual(["feature:effects.v2"])
      expect(sent).toHaveLength(0)
      expect(executed).toEqual([])
    }
  })

  test("denies without sending when the principal is not authenticated ServerAuth", async () => {
    const log: Log = []
    const { host, sent } = fixture({ log, principal: { kind: "host_os" } })
    const { outcome, executed } = await run({ host, log, principal: { kind: "host_os" } })
    expect(outcome.status).toBe("denied")
    if (outcome.status !== "denied") throw new Error("expected a denied wave")
    expect(outcome.failure.phase).toBe("request")
    expect(log).toEqual(["feature:effects.v2"])
    expect(sent).toHaveLength(0)
    expect(executed).toEqual([])
  })

  test("rejects a malformed request identity before any host interaction", async () => {
    for (const malformedRequestID of ["", "request id", `request-${"x".repeat(256)}`, "request\nid"]) {
      const log: Log = []
      const { host, sent } = fixture({ log })
      const outcome = await Effect.runPromise(
        DirectReadBatch.runWave({
          host,
          sessionID,
          locationRef,
          requestID: malformedRequestID,
          lane: "direct_session",
          codeMode: false,
          calls: [call("read-1")],
          execute: () => Effect.sync(() => [{ callID: "read-1", status: "settled" as const, output: "ok" }]),
        }).pipe(Effect.provideService(TrustedPrincipalContext, { principal })),
      )
      expect(outcome.status).toBe("denied")
      if (outcome.status !== "denied") throw new Error("expected a denied wave")
      expect(outcome.failure.phase).toBe("request")
      expect(outcome.failure.replay).toBe("forbidden")
      expect(log).toEqual([])
      expect(sent).toHaveLength(0)
    }
  })

  test("a possibly-sent admission failure is UNKNOWN, is never retried and never executes", async () => {
    const log: Log = []
    const { host, sent } = fixture({ log, hostFail: true })
    const { outcome, executed } = await run({ host, log })
    expect(outcome.status).toBe("denied")
    if (outcome.status !== "denied") throw new Error("expected a denied wave")
    expect(outcome.failure.phase).toBe("host")
    expect(outcome.failure.unknown).toBe(true)
    expect(outcome.failure.replay).toBe("forbidden")
    expect(sent).toHaveLength(1)
    expect(log).not.toContain("execute")
    expect(executed).toEqual([])
    expect(log).not.toContain("snapshot")
  })

  test("a substituted host response denies the wave before any read executes", async () => {
    const log: Log = []
    const { host, sent } = fixture({ log, body: response([row({ callID: "foreign-9" })]) })
    const { outcome, executed } = await run({ host, log })
    expect(outcome.status).toBe("denied")
    if (outcome.status !== "denied") throw new Error("expected a denied wave")
    expect(outcome.failure.phase).toBe("response")
    expect(sent).toHaveLength(1)
    expect(executed).toEqual([])
    expect(log).not.toContain("snapshot")
  })

  test("publishes nothing when the settled wave is incomplete, foreign or over budget", async () => {
    const cases = [
      [{ callID: "read-1", status: "unknown" as const }],
      [{ callID: "foreign-9", status: "settled" as const, output: "ok" }],
      [{ callID: "read-1", status: "settled" as const, output: "x".repeat(51201) }],
      [],
    ]
    for (const results of cases) {
      const log: Log = []
      const { host } = fixture({ log })
      const { outcome } = await run({
        host,
        log,
        execute: () => Effect.sync(() => results),
      })
      expect(outcome.status).toBe("denied")
      if (outcome.status !== "denied") throw new Error("expected a denied wave")
      expect(outcome.failure.phase).toBe("result")
      expect(outcome.failure).not.toHaveProperty("calls")
      expect(log).toContain("snapshot")
    }
  })

  test("re-reads the authenticated workspace only after the reads and denies a moved revision", async () => {
    const log: Log = []
    const { host, snapshots } = fixture({ log, snapshotRevision: `blake3:${"9".repeat(64)}` })
    const { outcome, executed } = await run({ host, log })
    expect(executed).toEqual(["read-1"])
    expect(log).toEqual(["feature:effects.v2", "register", "send", "execute", "snapshot"])
    expect(snapshots).toEqual([sessionID])
    expect(outcome.status).toBe("denied")
    if (outcome.status !== "denied") throw new Error("expected a denied wave")
    expect(outcome.failure.phase).toBe("fence")
    expect(outcome.failure.unknown).toBe(true)
    expect(outcome).not.toHaveProperty("calls")
  })

  test("an unavailable or failing workspace snapshot denies the complete wave", async () => {
    const log: Log = []
    const { host } = fixture({ log, snapshotFail: true })
    const { outcome } = await run({ host, log })
    expect(outcome.status).toBe("denied")
    if (outcome.status !== "denied") throw new Error("expected a denied wave")
    expect(outcome.failure.phase).toBe("fence")
    expect(outcome.failure.unknown).toBe(true)
    expect(outcome.failure.replay).toBe("forbidden")
    expect(outcome).not.toHaveProperty("calls")
  })

  test("an unresolvable Location denies the wave before any admission is sent", async () => {
    const log: Log = []
    const sent: Sent[] = []
    const host = {
      hostFeatureEnabled: () => Effect.succeed(true),
      registerHostLocation: () => Effect.fail(new Error("location registration refused")),
      requestHostKernel: () => {
        sent.push({ serviceID: "unreachable", operation: "unreachable", body: {} })
        return Effect.succeed({})
      },
      directSessionWorkspaceSnapshot: () => Effect.die("unreachable"),
    } as unknown as DirectReadHostV1
    const { outcome, executed } = await run({ host, log })
    expect(outcome.status).toBe("denied")
    if (outcome.status !== "denied") throw new Error("expected a denied wave")
    expect(outcome.failure.phase).toBe("request")
    expect(sent).toHaveLength(0)
    expect(executed).toEqual([])
  })
})
