import { describe, expect, test } from "bun:test"
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { encodeCanonicalMessagePackV1, Location } from "@opencode-ai/schema"
import fs from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { TrustedPrincipalContext, type TrustedPrincipal } from "../src/trusted-principal"
import {
  DirectReadBatch,
  type DirectReadHostV1,
  type DirectReadProjectionV1,
} from "../src/session/direct-read-batch"
import { directReadFastPathV1 } from "../src/session/runner/llm"

/**
 * P1-10 runner wiring (§14.3.1 / DEC-V1-36): the runner seam must route an
 * authenticated **direct-Session** read-class wave through the Core read
 * caller, bind `options.requestID` to the exact envelope it sends so every
 * projection row matches exactly, and fall back to ordinary Guard admission
 * for everything else. Managed Attempts and child lanes are explicitly
 * *not* enabled (§14.3.1 "Managed lane … off by default"; DEC-V1-36 keeps
 * managed chains strict).
 */

const sessionID = "ses_p7_read_route"
const locationID = `loc_${"a".repeat(64)}`
const workspaceRevision = `blake3:${"c".repeat(64)}`
const policyDigest = `blake3:${"d".repeat(64)}`
const modeDigest = `blake3:${"e".repeat(64)}`
const workspaceBinding = `blake3:${"f".repeat(64)}`
const subjectBinding = `blake3:${"1".repeat(64)}`
const locationRef = { directory: "/p7-fixture" } as unknown as Location.Ref
const principal: TrustedPrincipal = { kind: "server_auth", subject: "p7-read-route" }
const snapshot = {
  sessionID,
  locationID,
  ownerEpoch: "7",
  workspaceRevision,
  workspaceRootDigest: `blake3:${"2".repeat(64)}`,
  observedAtUnixMs: "1712345678901",
}

const readCall = (callID: string, path_ = "src/app.ts") => ({
  callID,
  capabilityID: "files.read",
  arguments: { path: path_, offset: 1, limit: 200 },
})

const writeCall = (callID: string) => ({
  callID,
  capabilityID: "files.write",
  arguments: { path: "src/app.ts", content: "x" },
})

function expectedArgumentsDigest(path_: string, offset: number, limit: number) {
  return `blake3:${bytesToHex(blake3(encodeCanonicalMessagePackV1({ path: path_, offset, limit })))}`
}

/** Contract-shaped row bound to the exact envelope `requestID` the host received. */
function row(callID: string, requestID: string, path_ = "src/app.ts") {
  const binding = {
    argumentsDigest: expectedArgumentsDigest(path_, 1, 200),
    callID,
    capabilityID: "files.read",
    locationID,
    limit: 200,
    offset: 1,
    ownerEpoch: "7",
    permissionModeDigest: modeDigest,
    policyDigest,
    requestID,
    resultBudgetBytes: 51200,
    revision: workspaceRevision,
    schemaVersion: 1,
    sessionID,
    subjectBinding,
    target: path_,
    workspaceBinding,
  }
  const preimage = new Uint8Array([
    ...new TextEncoder().encode("horizoncode.direct-read-lease.v1\0"),
    ...encodeCanonicalMessagePackV1(binding),
  ])
  return { ...binding, readLeaseDigest: `blake3:${bytesToHex(blake3(preimage))}` }
}

type Sent = {
  serviceID: string
  operation: string
  body: Readonly<Record<string, unknown>>
  options?: { requestID?: string; trustedPrincipal?: TrustedPrincipal; authenticatedContext?: unknown }
}

function fixture(options: { readonly sent: Sent[]; readonly boundRows?: boolean }) {
  const host = {
    hostFeatureEnabled: () => Effect.succeed(true),
    registerHostLocation: () => Effect.succeed(locationID),
    requestHostKernel: (
      serviceID: string,
      operation: string,
      body: Readonly<Record<string, unknown>>,
      request: Sent["options"],
    ) => {
      options.sent.push({ serviceID, operation, body, options: request })
      // Rows are bound to the envelope ID the caller actually sent — exactly
      // what P1's `options.requestID` makes matchable end to end.
      const bound = request?.requestID ?? "foreign-request"
      const calls = (body.calls ?? []) as ReadonlyArray<{ callID: string; arguments: { path: string } }>
      return Effect.succeed({
        schemaVersion: 1,
        workspaceRevision,
        calls: calls.map((call) => row(call.callID, options.boundRows === false ? "someone-else" : bound, call.arguments.path)),
      } as unknown as Readonly<Record<string, unknown>>)
    },
    directSessionWorkspaceSnapshot: () => Effect.succeed({ ...snapshot }),
  } as unknown as DirectReadHostV1
  return host
}

function run(
  host: DirectReadHostV1,
  input: {
    readonly calls: ReadonlyArray<{ callID: string; capabilityID: string; arguments: unknown }>
    readonly lane?: "direct_session" | "managed_attempt" | "direct_attempt"
    readonly codeMode?: boolean
    readonly parentSessionID?: string
    readonly requestID?: string
  },
) {
  return Effect.runPromise(
    directReadFastPathV1({
      host,
      sessionID,
      locationRef,
      lane: input.lane ?? "direct_session",
      codeMode: input.codeMode ?? false,
      ...(input.parentSessionID === undefined ? {} : { parentSessionID: input.parentSessionID }),
      ...(input.requestID === undefined ? {} : { requestID: input.requestID }),
      calls: input.calls,
      execute: (projections: ReadonlyArray<DirectReadProjectionV1>) =>
        Effect.succeed(
          projections.map((projection) => ({ callID: projection.callID, status: "settled" as const, output: "ok" })),
        ),
    }).pipe(Effect.provideService(TrustedPrincipalContext, { principal })),
  )
}

describe("P1-10 runner read fast path routing (DEC-V1-36)", () => {
  test("a read-class direct-Session batch is routed through the fast path with an exact envelope requestID", async () => {
    expect(typeof directReadFastPathV1).toBe("function")
    const sent: Sent[] = []
    const host = fixture({ sent })

    const outcome = await run(host, { calls: [readCall("read-1"), readCall("read-2", "src/b.ts")] })

    expect(outcome.status).toBe("published")
    expect(sent).toHaveLength(1)
    expect(sent[0]!.serviceID).toBe("effects.v2")
    expect(sent[0]!.operation).toBe("prepare_tool_batch_read")
    // The envelope carries the requestID so each projection row matches it exactly.
    expect(typeof sent[0]!.options?.requestID).toBe("string")
    expect(sent[0]!.options!.requestID).toMatch(/^[A-Za-z0-9._:-]{1,256}$/)
    expect(sent[0]!.options!.authenticatedContext).toMatchObject({ kind: "repo_read", sessionID })
    if (outcome.status !== "published") throw new Error(`expected a published wave, received ${outcome.status}`)
    expect(outcome.calls.map((call) => call.callID)).toEqual(["read-1", "read-2"])
  })

  test("an explicitly bound requestID is the one sent, and rows bound to another request are rejected whole-wave", async () => {
    expect(typeof directReadFastPathV1).toBe("function")
    const sent: Sent[] = []
    const ok = await run(fixture({ sent }), { calls: [readCall("read-1")], requestID: "p7.bound-request_1" })
    expect(ok.status).toBe("published")
    expect(sent[0]!.options?.requestID).toBe("p7.bound-request_1")

    const mismatch = await run(fixture({ sent, boundRows: false }), {
      calls: [readCall("read-1")],
      requestID: "p7.bound-request_2",
    })
    expect(mismatch.status).toBe("denied")
    expect((mismatch as { failure: { phase: string; replay: string; unknown: boolean } }).failure.phase).toBe("response")
    expect((mismatch as { failure: { replay: string } }).failure.replay).toBe("forbidden")
    expect((mismatch as { calls?: unknown }).calls).toBeUndefined()
  })

  test("a mixed read+effect batch falls back to the ordinary Guard admission path", async () => {
    expect(typeof directReadFastPathV1).toBe("function")
    const sent: Sent[] = []
    const outcome = await run(fixture({ sent }), {
      calls: [readCall("read-1"), writeCall("write-1")],
    })

    expect(outcome.status).toBe("unavailable")
    expect(sent).toHaveLength(0)
  })

  test("a wave above the eight-call bound is denied locally before any host contact", async () => {
    expect(typeof directReadFastPathV1).toBe("function")
    const sent: Sent[] = []
    const calls = Array.from({ length: 9 }, (_, index) => readCall(`read-${index}`))
    const outcome = await run(fixture({ sent }), { calls })

    expect(outcome.status).toBe("denied")
    const failure = (outcome as { failure: { phase: string; replay: string; unknown: boolean; reason: string } })
      .failure
    expect(failure.phase).toBe("request")
    expect(failure.replay).toBe("forbidden")
    expect(failure.unknown).toBe(false)
    expect(sent).toHaveLength(0)
  })

  test("managed Attempt and child lanes never take the fast path (§14.3.1 managed lane off by default)", async () => {
    expect(typeof directReadFastPathV1).toBe("function")
    const sent: Sent[] = []
    const managed = await run(fixture({ sent }), { calls: [readCall("read-1")], lane: "managed_attempt" })
    expect(managed.status).toBe("unavailable")

    const attempt = await run(fixture({ sent }), { calls: [readCall("read-1")], lane: "direct_attempt" })
    expect(attempt.status).toBe("unavailable")

    const child = await run(fixture({ sent }), {
      calls: [readCall("read-1")],
      parentSessionID: "ses_parent",
    })
    expect(child.status).toBe("unavailable")

    const codeMode = await run(fixture({ sent }), { calls: [readCall("read-1")], codeMode: true })
    expect(codeMode.status).toBe("unavailable")
    expect(sent).toHaveLength(0)
  })

  test("the runner seam actually invokes the fast path (wiring is present in llm.ts)", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "../src/session/runner/llm.ts"), "utf8")
    // The definition is an `Effect.fn(...)` const; a runner-side `yield*` proves
    // the routing decision is wired at the batch site, not just exported.
    expect(source).toContain("yield* directReadFastPathV1(")
    expect(source).toContain("export const directReadFastPathV1")
  })
})
