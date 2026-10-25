import { afterEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Server } from "../../src/server/server"
import * as ServerAuth from "../../src/server/auth"
import { PtyPaths } from "../../src/server/routes/instance/httpapi/groups/pty"
import { withTimeout } from "../../src/util/timeout"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const original = {
  OPENCODE_SERVER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: Flag.OPENCODE_SERVER_USERNAME,
  envPassword: process.env.OPENCODE_SERVER_PASSWORD,
  envUsername: process.env.OPENCODE_SERVER_USERNAME,
}
const auth = { username: "opencode", password: "listen-secret" }
const testPty = process.platform === "win32" ? test.skip : test
// Interactive terminals are fail-closed on Linux: hz-kernel cannot guarantee process-tree
// cleanup after owner loss, so creation must refuse with a typed 503 instead of spawning.
const ptyRefusedOnThisPlatform = process.platform !== "win32"
// These cases drive an accepted PTY websocket end to end, which requires a backend that
// starts terminals; Linux refuses interactive start, so they are Windows-only.
const testWinPty = process.platform === "win32" ? test : test.skip

afterEach(async () => {
  Flag.OPENCODE_SERVER_PASSWORD = original.OPENCODE_SERVER_PASSWORD
  Flag.OPENCODE_SERVER_USERNAME = original.OPENCODE_SERVER_USERNAME
  if (original.envPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = original.envPassword
  if (original.envUsername === undefined) delete process.env.OPENCODE_SERVER_USERNAME
  else process.env.OPENCODE_SERVER_USERNAME = original.envUsername
  await disposeAllInstances()
  await resetDatabase()
})

async function startListener() {
  Flag.OPENCODE_SERVER_PASSWORD = auth.password
  Flag.OPENCODE_SERVER_USERNAME = auth.username
  process.env.OPENCODE_SERVER_PASSWORD = auth.password
  process.env.OPENCODE_SERVER_USERNAME = auth.username
  return Server.listen({ hostname: "127.0.0.1", port: 0 })
}

async function startNoAuthListener() {
  Flag.OPENCODE_SERVER_PASSWORD = undefined
  Flag.OPENCODE_SERVER_USERNAME = auth.username
  delete process.env.OPENCODE_SERVER_PASSWORD
  process.env.OPENCODE_SERVER_USERNAME = auth.username
  return Server.listen({ hostname: "127.0.0.1", port: 0 })
}

function authorization() {
  return `Basic ${btoa(`${auth.username}:${auth.password}`)}`
}

function socketURL(listener: Awaited<ReturnType<typeof startListener>>, id: string, dir: string, ticket?: string) {
  const url = new URL(PtyPaths.connect.replace(":ptyID", id), listener.url)
  url.protocol = "ws:"
  url.searchParams.set("directory", dir)
  url.searchParams.set("cursor", "-1")
  if (ticket) url.searchParams.set("ticket", ticket)
  return url
}

async function requestTicket(
  listener: Awaited<ReturnType<typeof startListener>>,
  id: string,
  dir: string,
  options?: { ticketHeader?: boolean; origin?: string },
) {
  const response = await fetch(new URL(PtyPaths.connectToken.replace(":ptyID", id), listener.url), {
    method: "POST",
    headers: {
      authorization: authorization(),
      origin: options?.origin ?? "oc://renderer",
      "x-opencode-directory": dir,
      ...(options?.ticketHeader === false ? {} : { "x-opencode-ticket": "1" }),
    },
  })

  return response
}

async function connectTicket(listener: Awaited<ReturnType<typeof startListener>>, id: string, dir: string) {
  const response = await requestTicket(listener, id, dir)
  expect(response.status).toBe(200)
  return (await response.json()) as { ticket: string; expires_in: number }
}

async function createCat(
  listener: Awaited<ReturnType<typeof startListener>>,
  dir: string,
): Promise<{ id: string } | undefined> {
  const response = await fetch(new URL(PtyPaths.create, listener.url), {
    method: "POST",
    headers: {
      authorization: authorization(),
      "x-opencode-directory": dir,
      "content-type": "application/json",
    },
    body: JSON.stringify({ command: "/bin/cat", title: "listen-smoke" }),
  })
  if (ptyRefusedOnThisPlatform) {
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ _tag: "ServiceUnavailableError" })
    return undefined
  }
  expect(response.status).toBe(200)
  return (await response.json()) as { id: string }
}

async function openSocket(url: URL, init?: { headers?: Record<string, string> }) {
  const Ctor = WebSocket as unknown as new (url: URL, init?: { headers?: Record<string, string> }) => WebSocket
  const ws = new Ctor(url, {
    headers: { authorization: authorization(), origin: "oc://renderer", ...init?.headers },
  })
  ws.binaryType = "arraybuffer"
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true })
      ws.addEventListener("error", () => reject(new Error("websocket failed before open")), { once: true })
    }),
    5_000,
    "timed out waiting for websocket open",
  )
  return ws
}

async function expectSocketRejected(url: URL, init?: { headers?: Record<string, string> }) {
  // Bun's WebSocket accepts an init object with headers; standard DOM types don't reflect that.
  const Ctor = WebSocket as unknown as new (url: URL, init?: { headers?: Record<string, string> }) => WebSocket
  const ws = new Ctor(url, {
    headers: { authorization: authorization(), origin: "oc://renderer", ...init?.headers },
  })
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      ws.addEventListener(
        "open",
        () => {
          ws.close(1000)
          reject(new Error("websocket opened"))
        },
        { once: true },
      )
      ws.addEventListener("error", () => resolve(), { once: true })
      ws.addEventListener("close", () => resolve(), { once: true })
    }),
    5_000,
    "timed out waiting for websocket rejection",
  )
}

function stop(listener: Awaited<ReturnType<typeof startListener>>, label: string) {
  return withTimeout(listener.stop(true), 10_000, label)
}

function waitForMessage(ws: WebSocket, predicate: (message: string) => boolean) {
  const decoder = new TextDecoder()
  let onMessage: ((event: MessageEvent) => void) | undefined
  return withTimeout(
    new Promise<string>((resolve) => {
      onMessage = (event: MessageEvent) => {
        const message = typeof event.data === "string" ? event.data : decoder.decode(event.data as ArrayBuffer)
        if (!predicate(message)) return
        resolve(message)
      }
      ws.addEventListener("message", onMessage)
    }),
    5_000,
    "timed out waiting for websocket message",
  ).finally(() => {
    if (onMessage) ws.removeEventListener("message", onMessage)
  })
}

async function openPtySocket(listener: Awaited<ReturnType<typeof startListener>>, dir: string) {
  const info = await createCat(listener, dir)
  if (!info) return
  const ticket = await connectTicket(listener, info.id, dir)
  const ws = await openSocket(socketURL(listener, info.id, dir, ticket.ticket))
  return {
    ws,
    closed: new Promise<void>((resolve) => ws.addEventListener("close", () => resolve(), { once: true })),
  }
}

describe("HttpApi Server.listen", () => {
  testPty("serves HTTP routes and upgrades PTY websocket through Server.listen", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const listener = await startListener()
    let stopped = false
    try {
      const response = await fetch(new URL(PtyPaths.shells, listener.url), {
        headers: { authorization: authorization(), "x-opencode-directory": tmp.path },
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: expect.any(String),
            name: expect.any(String),
            acceptable: expect.any(Boolean),
          }),
        ]),
      )

      const info = await createCat(listener, tmp.path)
      if (!info) return
      const ticket = await connectTicket(listener, info.id, tmp.path)
      expect(ticket.expires_in).toBeGreaterThan(0)
      const ws = await openSocket(socketURL(listener, info.id, tmp.path, ticket.ticket))
      const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve(), { once: true }))

      const message = waitForMessage(ws, (message) => message.includes("ping-listen"))
      ws.send("ping-listen\n")
      expect(await message).toContain("ping-listen")

      await stop(listener, "timed out waiting for listener.stop(true)")
      stopped = true
      await withTimeout(closed, 5_000, "timed out waiting for websocket close")
      expect(ws.readyState).toBe(WebSocket.CLOSED)

      const restarted = await startListener()
      try {
        const nextInfo = await createCat(restarted, tmp.path)
        if (!nextInfo) return
        const nextTicket = await connectTicket(restarted, nextInfo.id, tmp.path)
        const nextWs = await openSocket(socketURL(restarted, nextInfo.id, tmp.path, nextTicket.ticket))
        const nextMessage = waitForMessage(nextWs, (message) => message.includes("ping-restarted"))
        nextWs.send("ping-restarted\n")
        expect(await nextMessage).toContain("ping-restarted")
        nextWs.close(1000)
      } finally {
        await stop(restarted, "timed out waiting for restarted listener.stop(true)")
      }
    } finally {
      if (!stopped) await stop(listener, "timed out cleaning up listener").catch(() => undefined)
    }
  })

  testWinPty("stop(true) is safe when called concurrently and repeatedly", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const listener = await startListener()
    let stopped = false
    try {
      const socket = await openPtySocket(listener, tmp.path)
      if (!socket) return

      await withTimeout(
        Promise.all([listener.stop(true), listener.stop(true)]).then(() => undefined),
        10_000,
        "timed out waiting for concurrent listener.stop(true)",
      )
      await withTimeout(socket.closed, 5_000, "timed out waiting for websocket close after concurrent stop")
      await withTimeout(listener.stop(true), 5_000, "timed out waiting for repeated listener.stop(true)")
      stopped = true
    } finally {
      if (!stopped) await stop(listener, "timed out cleaning up concurrent stop listener").catch(() => undefined)
    }
  })

  testWinPty("stop(true) can force a graceful stop already in progress", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const listener = await startListener()
    let stopped = false
    try {
      const socket = await openPtySocket(listener, tmp.path)
      if (!socket) return

      const graceful = listener.stop()
      const forced = listener.stop(true)
      await withTimeout(
        Promise.all([graceful, forced]).then(() => undefined),
        10_000,
        "timed out waiting for forced listener stop",
      )
      await withTimeout(socket.closed, 5_000, "timed out waiting for websocket close after forced stop")
      stopped = true
    } finally {
      if (!stopped) await stop(listener, "timed out cleaning up forced stop listener").catch(() => undefined)
    }
  })

  testWinPty("graceful stop waits for an overlapping forced stop", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const listener = await startListener()
    let stopped = false
    try {
      const socket = await openPtySocket(listener, tmp.path)
      if (!socket) return
      const forced = listener.stop(true)
      await withTimeout(listener.stop(), 10_000, "timed out waiting for graceful stop after forced stop")
      stopped = true
      await withTimeout(forced, 5_000, "timed out waiting for overlapping forced stop")
      await withTimeout(socket.closed, 5_000, "timed out waiting for websocket close before graceful stop resolved")
    } finally {
      if (!stopped) await stop(listener, "timed out cleaning up overlapping stop listener").catch(() => undefined)
    }
  })

  test("stop() gracefully closes an idle listener and is repeat-safe", async () => {
    const listener = await startListener()
    await withTimeout(listener.stop(), 10_000, "timed out waiting for graceful listener.stop()")
    await withTimeout(listener.stop(), 5_000, "timed out waiting for repeated graceful listener.stop()")
    await expect(
      fetch(new URL(PtyPaths.shells, listener.url), { headers: { authorization: authorization() } }),
    ).rejects.toThrow()
  })

  test("default in-process handler does not emit Effect HTTP response logs", async () => {
    let output = ""
    // oxlint-disable-next-line typescript-eslint/unbound-method -- restored in finally after temporarily capturing stderr.
    const original = process.stderr.write
    process.stderr.write = ((chunk) => {
      output += String(chunk)
      return true
    }) as typeof process.stderr.write
    try {
      const response = await Server.Default().app.request("/status")
      expect(response.status).toBe(200)
    } finally {
      process.stderr.write = original
    }

    expect(output).not.toContain("Sent HTTP response")
  })

  // Regression for the production `opencode serve` startup defect:
  // `handlers/websearch.ts` yields `WebSearchRuntime.Service` while the instance
  // handler groups build, but the production app LayerNode group never exposed
  // `WebSearchRuntime.node`, so every listener died at build time with
  // `Service not found: @horizoncode/WebSearchRuntime` before it could serve a
  // single request. This test builds the real route tree through `Server.listen`
  // with no route-boundary mock and asserts the honest gate-false answer: the
  // service is genuinely present, and web search reports itself disabled rather
  // than no-oping or crashing.
  test("serves an honest web-search provider status from the real route tree without a boundary mock", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const listener = await startListener()
    try {
      const response = await fetch(new URL("/websearch/providers", listener.url), {
        headers: { authorization: authorization(), "x-opencode-directory": tmp.path },
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as Array<{
        provider: string
        status: string
        available: boolean
        configured: boolean
        unavailableReason?: string
      }>
      expect(body.length).toBeGreaterThan(0)
      for (const entry of body) {
        // Gate-false configuration: no consent, no Guarded runtime release, so
        // no route may claim readiness or availability.
        expect(entry.status).not.toBe("ready")
        expect(["disabled", "unconfigured", "unavailable"]).toContain(entry.status)
        expect(entry.available).toBe(false)
        expect(typeof entry.unavailableReason).toBe("string")
        expect(entry.unavailableReason!.length).toBeGreaterThan(0)
      }
    } finally {
      await stop(listener, "timed out cleaning up web-search status listener")
    }
  })

  test("feature setting update and rollback preserve unrelated config and reject stale writes", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(
          path.join(directory, "opencode.json"),
          JSON.stringify({
            compaction: { auto: false, prune: false },
            experimental: { batch_tool: true },
            formatter: false,
          }),
        )
        await Bun.write(
          path.join(directory, "config.json"),
          JSON.stringify({ compaction: { auto: true }, formatter: false }),
        )
      },
    })
    const listener = await startListener()
    const headers = { authorization: authorization(), "content-type": "application/json" }
    const query = `directory=${encodeURIComponent(tmp.path)}`
    try {
      const initial = await fetch(new URL(`/config/features?${query}`, listener.url), { headers })
      expect(initial.status).toBe(200)
      const before = (await initial.json()) as Array<{
        featureId: string
        state: {
          requestedEnabled: boolean | null
          effectiveEnabled: boolean
          effectiveState: string
          valueSource: string
          policyLock: string
        }
      }>
      expect(before.find((feature) => feature.featureId === "compaction.prune")?.state).toMatchObject({
        requestedEnabled: false,
        effectiveEnabled: false,
        effectiveState: "off",
        valueSource: "project",
        policyLock: "unlocked",
      })
      expect(before.find((feature) => feature.featureId === "native_search")?.state).toMatchObject({
        effectiveEnabled: false,
        effectiveState: "unavailable",
        implementationStatus: "designed",
      })

      // Designed-only experiments remain unavailable through the HTTP
      // boundary too; a client cannot bypass the TUI's disabled state.
      const unavailable = await fetch(new URL(`/config/features?${query}`, listener.url), {
        method: "PATCH",
        headers,
        body: JSON.stringify({ featureId: "native_search", expectedEnabled: null, enabled: true }),
      })
      expect(unavailable.status).toBe(400)

      const update = await fetch(new URL(`/config/features?${query}`, listener.url), {
        method: "PATCH",
        headers,
        body: JSON.stringify({ featureId: "compaction.prune", expectedEnabled: false, enabled: true }),
      })
      expect(update.status).toBe(200)
      const after = (await update.json()) as Array<{
        featureId: string
        state: {
          requestedEnabled: boolean | null
          effectiveEnabled: boolean
          effectiveState: string
          pendingApplyAt?: string
        }
      }>
      expect(after.find((feature) => feature.featureId === "compaction.prune")?.state).toMatchObject({
        requestedEnabled: true,
        effectiveEnabled: false,
        effectiveState: "pending_apply",
        pendingApplyAt: "next_turn",
      })

      // Roll back the setting after the pending update. The write path must
      // preserve other settings and still fence stale/concurrent requests.

      const stale = await fetch(new URL(`/config/features?${query}`, listener.url), {
        method: "PATCH",
        headers,
        body: JSON.stringify({ featureId: "compaction.prune", expectedEnabled: false, enabled: false }),
      })
      expect(stale.status).toBe(409)

      const concurrent = await Promise.all(
        [0, 1].map(() =>
          fetch(new URL(`/config/features?${query}`, listener.url), {
            method: "PATCH",
            headers,
            body: JSON.stringify({ featureId: "compaction.prune", expectedEnabled: true, enabled: false }),
          }),
        ),
      )
      expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409])

      const final = await fetch(new URL(`/config/features?${query}`, listener.url), { headers })
      expect(final.status).toBe(200)
      const finalFeatures = (await final.json()) as Array<{
        featureId: string
        state: { requestedEnabled: boolean | null; effectiveEnabled: boolean }
      }>
      expect(finalFeatures.find((feature) => feature.featureId === "compaction.prune")?.state).toMatchObject({
        requestedEnabled: false,
        effectiveEnabled: false,
      })
      const persisted = JSON.parse(await Bun.file(path.join(tmp.path, "config.json")).text())
      expect(persisted).toMatchObject({ compaction: { auto: true, prune: false }, formatter: false })
    } finally {
      await listener.stop()
    }
  })

  test("managed feature settings report their policy source and reject writes", async () => {
    await using tmp = await tmpdir()
    const managed = path.join(tmp.path, "managed")
    await mkdir(managed, { recursive: true })
    await Bun.write(path.join(managed, "opencode.json"), JSON.stringify({ compaction: { auto: false } }))
    const previousManagedDir = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
    process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = managed
    const listener = await startListener()
    const headers = { authorization: authorization(), "content-type": "application/json" }
    const query = `directory=${encodeURIComponent(tmp.path)}`
    try {
      const initial = await fetch(new URL(`/config/features?${query}`, listener.url), { headers })
      expect(initial.status).toBe(200)
      const features = (await initial.json()) as Array<{
        featureId: string
        state: { requestedEnabled: boolean | null; effectiveEnabled: boolean; valueSource: string; policyLock: string }
      }>
      expect(features.find((feature) => feature.featureId === "compaction.auto")?.state).toMatchObject({
        requestedEnabled: false,
        effectiveEnabled: false,
        valueSource: "system_policy",
        policyLock: "locked",
      })

      const update = await fetch(new URL(`/config/features?${query}`, listener.url), {
        method: "PATCH",
        headers,
        body: JSON.stringify({ featureId: "compaction.auto", expectedEnabled: false, enabled: true }),
      })
      expect(update.status, await update.clone().text()).toBe(403)
      const persisted = await Bun.file(path.join(tmp.path, "config.json")).exists()
      expect(persisted).toBe(false)
      expect(JSON.parse(await Bun.file(path.join(managed, "opencode.json")).text())).toMatchObject({
        compaction: { auto: false },
      })
    } finally {
      await listener.stop()
      if (previousManagedDir === undefined) delete process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
      else process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = previousManagedDir
    }
  })

  test("port 0 prefers 4096 when free", async () => {
    if (!(await isPortFree(4096))) return
    const listener = await startListener()
    try {
      expect(listener.port).toBe(4096)
    } finally {
      await stop(listener, "timed out cleaning up port-0 prefers-4096 listener")
    }
  })

  test("port 0 falls back when 4096 is taken", async () => {
    const blocker = await occupyPort(4096)
    if (!blocker) return
    try {
      const listener = await startListener()
      try {
        expect(listener.port).not.toBe(4096)
        expect(listener.port).toBeGreaterThan(0)
      } finally {
        await stop(listener, "timed out cleaning up port-0 fallback listener")
      }
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  testPty("rejects unsafe PTY ticket mint and connect requests", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const listener = await startListener()
    try {
      const info = await createCat(listener, tmp.path)
      if (!info) return

      expect((await requestTicket(listener, info.id, tmp.path, { ticketHeader: false })).status).toBe(403)
      expect((await requestTicket(listener, info.id, tmp.path, { origin: "https://evil.example" })).status).toBe(403)
      expect(
        (await requestTicket(listener, info.id, tmp.path, { origin: "oc://renderer.attacker" })).status,
      ).toBe(403)
      expect((await requestTicket(listener, info.id, tmp.path, { origin: "" })).status).toBe(403)

      const missingOrigin = await fetch(new URL(PtyPaths.connectToken.replace(":ptyID", info.id), listener.url), {
        method: "POST",
        headers: {
          authorization: authorization(),
          "x-opencode-ticket": "1",
          "x-opencode-directory": tmp.path,
        },
      })
      expect(missingOrigin.status).toBe(403)

      // Regression for #25698: minting without a directory uses the server cwd
      // and cannot find a PTY registered in a project directory.
      const ambiguous = await fetch(new URL(PtyPaths.connectToken.replace(":ptyID", info.id), listener.url), {
        method: "POST",
        headers: { authorization: authorization(), "x-opencode-ticket": "1" },
      })
      expect(ambiguous.status).toBe(404)

      const directoryScoped = await fetch(
        new URL(
          `${PtyPaths.connectToken.replace(":ptyID", info.id)}?directory=${encodeURIComponent(tmp.path)}`,
          listener.url,
        ),
        {
          method: "POST",
          headers: {
            authorization: authorization(),
            origin: "oc://renderer",
            "x-opencode-ticket": "1",
          },
        },
      )
      expect(directoryScoped.status).toBe(200)
      const v2Token = await fetch(
        new URL(
          `/api/pty/${info.id}/connect-token?location[directory]=${encodeURIComponent(tmp.path)}`,
          listener.url,
        ),
        {
          method: "POST",
          headers: {
            authorization: authorization(),
            origin: "oc://renderer",
            "x-opencode-ticket": "1",
            "x-opencode-directory": tmp.path,
          },
        },
      )
      expect(v2Token.status).toBe(200)

      const invalidProtocolURL = socketURL(listener, info.id, tmp.path).toString().replace(/^ws:/, "http:")
      const unknownProtocol = await fetch(invalidProtocolURL, {
        headers: {
          authorization: authorization(),
          origin: "oc://renderer",
          "sec-websocket-protocol": "unknown.protocol",
        },
      })
      expect(unknownProtocol.status).toBe(400)

      const multipleProtocols = await fetch(invalidProtocolURL, {
        headers: {
          authorization: authorization(),
          origin: "oc://renderer",
          "sec-websocket-protocol": "horizon.terminal.v1, other",
        },
      })
      expect(multipleProtocols.status).toBe(400)
      const mint = (await directoryScoped.json()) as { ticket: string }
      const scopedWs = await openSocket(socketURL(listener, info.id, tmp.path, mint.ticket))
      scopedWs.close(1000)

      await expectSocketRejected(socketURL(listener, info.id, tmp.path, "not-a-ticket"))

      const reusable = await connectTicket(listener, info.id, tmp.path)
      const legacyV2 = socketURL(listener, info.id, tmp.path, reusable.ticket)
      legacyV2.protocol = "http:"
      const rejectedV2 = await fetch(legacyV2, {
        headers: {
          authorization: authorization(),
          origin: "oc://renderer",
          "sec-websocket-protocol": "horizon.terminal.v1",
        },
      })
      expect(rejectedV2.status).toBe(403)
      const ws = await openSocket(socketURL(listener, info.id, tmp.path, reusable.ticket))
      await expectSocketRejected(socketURL(listener, info.id, tmp.path, reusable.ticket))
      ws.close(1000)
      const invalidApi = await fetch(
        new URL(
          `/api/pty/${info.id}/connect?ticket=not-a-ticket&location[directory]=${encodeURIComponent(tmp.path)}`,
          listener.url,
        ),
        {
          headers: { authorization: authorization(), origin: "oc://renderer" },
        },
      )
      expect(invalidApi.status).toBe(403)

      const other = await createCat(listener, tmp.path)
      if (!other) return
      const scoped = await connectTicket(listener, info.id, tmp.path)
      await expectSocketRejected(socketURL(listener, other.id, tmp.path, scoped.ticket))

      const crossOrigin = await connectTicket(listener, info.id, tmp.path)
      await expectSocketRejected(socketURL(listener, info.id, tmp.path, crossOrigin.ticket), {
        headers: { origin: "https://evil.example" },
      })
    } finally {
      await stop(listener, "timed out cleaning up rejected ticket listener").catch(() => undefined)
    }
  })

  testPty("uses one-use host tickets for canonical V2 PTY attachments", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const listener = await startListener()
    let ws: WebSocket | undefined
    try {
      const locationQuery = `location[directory]=${encodeURIComponent(tmp.path)}`
      const created = await fetch(new URL(`/api/pty?${locationQuery}`, listener.url), {
        method: "POST",
        headers: {
          authorization: authorization(),
          origin: "oc://renderer",
          "content-type": "application/json",
        },
        body: JSON.stringify({ command: "/bin/cat", title: "v2-host-ticket" }),
      })
      if (ptyRefusedOnThisPlatform) {
        expect(created.status).toBe(503)
        expect(await created.json()).toMatchObject({ _tag: "ServiceUnavailableError" })
        return
      }
      expect(created.status).toBe(200)
      const info = (await created.json()) as { data: { id: string } }

      const minted = await fetch(new URL(`/api/pty/${info.data.id}/connect-token?${locationQuery}`, listener.url), {
        method: "POST",
        headers: {
          authorization: authorization(),
          origin: "oc://renderer",
          "x-opencode-ticket": "1",
        },
      })
      const unsupportedOrigin = await fetch(
        new URL(`/api/pty/${info.data.id}/connect-token?${locationQuery}`, listener.url),
        {
          method: "POST",
          headers: {
            authorization: authorization(),
            origin: "oc://renderer.attacker",
            "x-opencode-ticket": "1",
          },
        },
      )
      expect(unsupportedOrigin.status).toBe(403)
      expect(minted.status).toBe(200)
      const token = (await minted.json()) as { data: { ticket: string; expires_in: number } }
      expect(token.data.ticket).toBeTruthy()
      expect(token.data.expires_in).toBeGreaterThan(0)
      const otherCreated = await fetch(new URL(`/api/pty?${locationQuery}`, listener.url), {
        method: "POST",
        headers: {
          authorization: authorization(),
          origin: "oc://renderer",
          "content-type": "application/json",
        },
        body: JSON.stringify({ command: "/bin/cat", title: "v2-host-ticket-other" }),
      })
      expect(otherCreated.status).toBe(200)
      const other = (await otherCreated.json()) as { data: { id: string } }

      const connect = new URL(`/api/pty/${info.data.id}/connect?${locationQuery}`, listener.url)
      connect.protocol = "ws:"
      connect.searchParams.set("ticket", token.data.ticket)
      const protocolHeader = { "sec-websocket-protocol": "horizon.terminal.v1" }

      const cachedTicket = await connectTicket(listener, info.data.id, tmp.path)
      const cachedV2 = new URL(connect)
      cachedV2.searchParams.set("ticket", cachedTicket.ticket)
      await expectSocketRejected(cachedV2, { headers: protocolHeader })
      const invalid = new URL(connect)
      invalid.searchParams.set("ticket", "not-a-valid-host-ticket")
      await expectSocketRejected(invalid, { headers: protocolHeader })
      const wrongSession = new URL(`/api/pty/${other.data.id}/connect?${locationQuery}`, listener.url)
      wrongSession.protocol = "ws:"
      wrongSession.searchParams.set("ticket", token.data.ticket)
      await expectSocketRejected(wrongSession, { headers: protocolHeader })
      await expectSocketRejected(connect, {
        headers: { ...protocolHeader, origin: "https://evil.example" },
      })

      const active = await openSocket(connect, { headers: protocolHeader })
      ws = active
      active.send("v2-host-ticket-output\n")
      expect(await waitForMessage(active, (message) => message.includes("v2-host-ticket-output"))).toContain(
        "v2-host-ticket-output",
      )
      const closed = new Promise<void>((resolve) => active.addEventListener("close", () => resolve(), { once: true }))
      active.close(1000)
      await withTimeout(closed, 5_000, "timed out waiting for V2 PTY close")
      await expectSocketRejected(connect, { headers: protocolHeader })
    } finally {
      ws?.close(1000)
      await stop(listener, "timed out cleaning up V2 host-ticket listener").catch(() => undefined)
    }
  })

  testPty("grants host OS only to a verified loopback peer without proxy metadata", async () => {
    expect(ServerAuth.isTrustedLoopbackPeer("127.0.0.1", {})).toBe(true)
    expect(ServerAuth.isTrustedLoopbackPeer("::1", {})).toBe(true)
    expect(ServerAuth.isTrustedLoopbackPeer("::ffff:127.0.0.1", {})).toBe(true)
    expect(ServerAuth.isTrustedLoopbackPeer("10.0.0.2", {})).toBe(false)
    expect(ServerAuth.isTrustedLoopbackPeer("not-an-ip", {})).toBe(false)
    expect(ServerAuth.isTrustedLoopbackPeer("127.0.0.1", { forwarded: "for=127.0.0.1" })).toBe(false)
    expect(ServerAuth.isTrustedLoopbackPeer("127.0.0.1", { "x-forwarded-for": "127.0.0.1" })).toBe(false)
    expect(ServerAuth.isTrustedLoopbackPeer("127.0.0.1", { "x-real-ip": "127.0.0.1" })).toBe(false)

    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const listener = await startNoAuthListener()
    try {
      const locationQuery = `location[directory]=${encodeURIComponent(tmp.path)}`
      const loopback = await fetch(new URL(`/api/pty?${locationQuery}`, listener.url), {
        method: "POST",
        headers: {
          origin: "oc://renderer",
          "content-type": "application/json",
        },
        body: JSON.stringify({ command: "/bin/cat", title: "loopback-host-os" }),
      })
      // A trusted loopback peer reaches the PTY backend: on Windows it creates a session, and
      // on Linux the host refuses the interactive start with 503 rather than a 403 trust denial.
      expect(loopback.status).toBe(ptyRefusedOnThisPlatform ? 503 : 200)
      if (ptyRefusedOnThisPlatform) {
        expect(await loopback.json()).toMatchObject({ _tag: "ServiceUnavailableError" })
      }

      const forwarded = await fetch(new URL(`/api/pty?${locationQuery}`, listener.url), {
        method: "POST",
        headers: {
          origin: "oc://renderer",
          "x-forwarded-for": "127.0.0.1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ command: "/bin/cat", title: "forwarded-host-os" }),
      })
      expect(forwarded.status).toBe(403)
      expect(await forwarded.json()).toMatchObject({ _tag: "ForbiddenError" })
      const approval = await fetch(
        new URL(`/guard/approval/approval_test/reply?directory=${encodeURIComponent(tmp.path)}`, listener.url), {
        method: "POST",
        headers: {
          "x-forwarded-for": "127.0.0.1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ decision: "allow_once" }),
      })
      expect(approval.status).toBe(403)
      expect(await approval.json()).toMatchObject({ _tag: "ForbiddenError" })
    } finally {
      await stop(listener, "timed out cleaning up loopback host OS listener").catch(() => undefined)
    }
  })
})

function isPortFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const probe = net.createServer()
    probe.once("error", () => resolve(false))
    probe.once("listening", () => probe.close(() => resolve(true)))
    probe.listen(port, "127.0.0.1")
  })
}

function occupyPort(port: number) {
  return new Promise<net.Server | undefined>((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(undefined))
    server.listen(port, "127.0.0.1", () => resolve(server))
  })
}
