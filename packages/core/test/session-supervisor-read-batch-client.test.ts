import { describe, expect, test } from "bun:test"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { HostKernelClientImpl, type HostKernelTransport } from "../src/session/supervisor"

/**
 * Client-side P1-10 seam acceptance.
 *
 * `requestHostKernel` already allowlists `effects.v2/prepare_tool_batch_read`
 * behind a private `repo_read` context, but `HostKernelClientImpl.request` is the
 * last gate before a frame is written: it must admit exactly that one operation,
 * keep every other `effects.v2` operation on a `repo_read` context denied, and
 * carry an optional caller-supplied envelope `requestID` so Core can bind every
 * projection row to an identity it already knows. Everything else — private
 * context kind, Session/Location equality with the body, feature negotiation and
 * the generated-ID default — must behave exactly as before.
 *
 * The client is driven over a `HostKernelTransport` double so the exact outgoing
 * envelope is inspectable without a host process; no socket, process or host
 * kernel is started here.
 */

const sessionID = "ses_read_batch_client"
const locationID = `loc_${"a".repeat(64)}`
const principal = { kind: "server_auth" as const, subject: "p1-direct-read" }
const context = { kind: "repo_read" as const, sessionID, locationID }
const readCall = {
  callID: "read-1",
  capabilityID: "files.read",
  arguments: { path: "src/app.ts", offset: 1, limit: 200 },
}
const body = { schemaVersion: 1, sessionID, locationID, calls: [readCall] }
const CLIENT_REASON = "authenticated read context is unavailable or invalid"
const REQUEST_ID_REASON = "RPC request id is invalid"
const GENERATED_REQUEST_ID = /^req_[0-9a-f]{32}$/

function double() {
  const sent: Array<Record<string, unknown>> = []
  const queued: Array<unknown> = []
  const waiters: Array<(value: unknown) => void> = []
  // `send` pushes synchronously so a test can inspect the exact envelope as soon
  // as `request()` reaches its first `await`.
  const transport: HostKernelTransport = {
    send: (value) => {
      sent.push({ ...value })
      return Promise.resolve()
    },
    receive: () => {
      const queuedValue = queued.shift()
      if (queuedValue !== undefined) return Promise.resolve(queuedValue)
      return new Promise<unknown>((resolve) => waiters.push(resolve))
    },
    end: () => undefined,
    isClosed: () => false,
    destroy: () => undefined,
  }
  const respond = (value: unknown) => {
    const waiter = waiters.shift()
    if (waiter) waiter(value)
    else queued.push(value)
  }
  return { transport, sent, respond }
}

function client(enabledFeatures: ReadonlyArray<string> = ["effects.v2"]) {
  const harness = double()
  const instance = new HostKernelClientImpl(
    harness.transport,
    {} as unknown as ChildProcessHandle,
    7,
    enabledFeatures,
  )
  return { instance, ...harness }
}

function okResponse(requestId: unknown, responseBody: Readonly<Record<string, unknown>> = { accepted: true }) {
  return { kind: "response", protocol: 1, requestId, outcome: "ok", body: { ...responseBody } }
}

describe("HostKernel client direct read-batch admission", () => {
  test("admits the allowlisted read-batch request and returns the host body", async () => {
    const { instance, sent, respond } = client()
    const pending = instance.request(
      "effects.v2",
      "prepare_tool_batch_read",
      body,
      undefined,
      undefined,
      principal,
      context,
    )
    expect(sent).toHaveLength(1)
    const envelope = sent[0]!
    expect(envelope.serviceId).toBe("effects.v2")
    expect(envelope.operation).toBe("prepare_tool_batch_read")
    expect(envelope.body).toEqual(body)
    expect(envelope.authenticatedPrincipal).toEqual({ kind: "server_auth", subject: principal.subject })
    expect(envelope.authenticatedContext).toEqual({ kind: "repo_read", sessionID, locationID })
    expect(envelope.requestId).toMatch(GENERATED_REQUEST_ID)
    respond(okResponse(envelope.requestId))
    expect(await pending).toEqual({ accepted: true })
  })

  test("still denies a foreign effects.v2 operation carried on a private repo_read context", async () => {
    const { instance, sent } = client()
    await expect(
      instance.request(
        "effects.v2",
        "prepare_tool_batch",
        body,
        undefined,
        undefined,
        principal,
        context,
      ),
    ).rejects.toThrow(CLIENT_REASON)
    await expect(
      instance.request(
        "effects.v2",
        "prepare_tool_batch_read_extra",
        body,
        undefined,
        undefined,
        principal,
        context,
      ),
    ).rejects.toThrow(CLIENT_REASON)
    expect(sent).toHaveLength(0)
  })

  test("still denies a read-batch body whose Session or Location differs from the context", async () => {
    const { instance, sent } = client()
    await expect(
      instance.request(
        "effects.v2",
        "prepare_tool_batch_read",
        { ...body, sessionID: "ses_other" },
        undefined,
        undefined,
        principal,
        context,
      ),
    ).rejects.toThrow(CLIENT_REASON)
    await expect(
      instance.request(
        "effects.v2",
        "prepare_tool_batch_read",
        { ...body, locationID: `loc_${"b".repeat(64)}` },
        undefined,
        undefined,
        principal,
        context,
      ),
    ).rejects.toThrow(CLIENT_REASON)
    expect(sent).toHaveLength(0)
  })

  test("still denies the read batch without the negotiated effects.v2 feature or a server_auth principal", async () => {
    const closed = client(["repo-intel.read-context-v1"])
    await expect(
      closed.instance.request(
        "effects.v2",
        "prepare_tool_batch_read",
        body,
        undefined,
        undefined,
        principal,
        context,
      ),
    ).rejects.toThrow(CLIENT_REASON)
    expect(closed.sent).toHaveLength(0)

    const unauthenticated = client()
    await expect(
      unauthenticated.instance.request(
        "effects.v2",
        "prepare_tool_batch_read",
        body,
        undefined,
        undefined,
        { kind: "host_os" },
        context,
      ),
    ).rejects.toThrow(CLIENT_REASON)
    expect(unauthenticated.sent).toHaveLength(0)
  })

  test("keeps the repo-intel repo_read gate unchanged", async () => {
    const admitted = client(["repo-intel.read-context-v1"])
    const pending = admitted.instance.request(
      "repo-intel.v1",
      "query_structure",
      { schemaVersion: 1 },
      undefined,
      undefined,
      principal,
      context,
    )
    expect(admitted.sent).toHaveLength(1)
    admitted.respond(okResponse(admitted.sent[0]!.requestId))
    expect(await pending).toEqual({ accepted: true })

    const denied = client(["effects.v2"])
    await expect(
      denied.instance.request(
        "repo-intel.v1",
        "query_structure",
        { schemaVersion: 1 },
        undefined,
        undefined,
        principal,
        context,
      ),
    ).rejects.toThrow(CLIENT_REASON)
    expect(denied.sent).toHaveLength(0)
  })
})

describe("caller-supplied envelope requestID", () => {
  test("echoes a validated caller-supplied requestID end-to-end", async () => {
    const { instance, sent, respond } = client()
    const pending = instance.request(
      "effects.v2",
      "prepare_tool_batch_read",
      body,
      undefined,
      undefined,
      principal,
      context,
      { requestID: "rpc_read_1" },
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]!.requestId).toBe("rpc_read_1")
    respond(okResponse("rpc_read_1", { accepted: true }))
    expect(await pending).toEqual({ accepted: true })
  })

  test("accepts a caller-supplied request ID at the canonical length limit", async () => {
    const { instance, sent, respond } = client()
    const requestID = `rpc_${"x".repeat(252)}`
    expect(requestID).toHaveLength(256)
    const pending = instance.request(
      "effects.v2",
      "prepare_tool_batch_read",
      body,
      undefined,
      undefined,
      principal,
      context,
      { requestID },
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]!.requestId).toBe(requestID)
    respond(okResponse(requestID))
    expect(await pending).toEqual({ accepted: true })
  })

  test("keeps the generated requestID when the caller supplies none", async () => {
    const { instance, sent, respond } = client()
    const pending = instance.request(
      "effects.v2",
      "prepare_tool_batch_read",
      body,
      undefined,
      undefined,
      principal,
      context,
    )
    const generated = sent[0]!.requestId
    expect(generated).toMatch(GENERATED_REQUEST_ID)
    expect(generated).not.toBe("rpc_read_1")
    respond(okResponse(generated))
    expect(await pending).toEqual({ accepted: true })
  })

  test("rejects malformed and oversized caller-supplied request IDs before send", async () => {
    const malformed = [
      "",
      "rpc read",
      "rpc/read",
      "rpc\u0001read",
      `rpc_${"x".repeat(256)}`,
      `rpc_${"x".repeat(512)}`,
    ]
    for (const requestID of malformed) {
      const { instance, sent } = client()
      await expect(
        instance.request(
          "effects.v2",
          "prepare_tool_batch_read",
          body,
          undefined,
          undefined,
          principal,
          context,
          { requestID },
        ),
      ).rejects.toThrow(REQUEST_ID_REASON)
      expect(sent).toHaveLength(0)
    }
  })

  test("rejects a caller-supplied request ID on any other operation", async () => {
    const { instance, sent } = client()
    await expect(
      instance.request("execution.v1", "git_read", { schemaVersion: 1 }, undefined, undefined, undefined, undefined, {
        requestID: "rpc_read_1",
      }),
    ).rejects.toThrow(REQUEST_ID_REASON)
    await expect(
      instance.request(
        "effects.v2",
        "prepare_tool_batch",
        body,
        undefined,
        undefined,
        principal,
        context,
        { requestID: "rpc_read_1" },
      ),
    ).rejects.toThrow(REQUEST_ID_REASON)
    expect(sent).toHaveLength(0)
  })
})
