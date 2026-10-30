// Acceptance suite for the Meterbase task. Held back from the implementer.
// It only exercises the public HTTP contract from TASK.md and the published
// specs (Stripe-compatible signatures, RFC 9457, RFC 6750 section 3, the IETF
// RateLimit-* fields), so it grades behaviour, not internals.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const TASK_DIR = dirname(dirname(import.meta.dir))
// Resolve the runtime that is executing this suite so a bare "bun" on $PATH is
// not required (the graded run must not depend on the caller's shell).
const BUN_BIN = process.execPath
// package.json scripts call the `bun` binary by name, so the child needs the
// running runtime first on its own $PATH.
const CHILD_PATH = `${dirname(BUN_BIN)}:${process.env.PATH ?? ""}`
const SECRET = "whsec_acceptance_secret_do_not_ship"

type Handle = { base: string; dataDir: string; logFile: string; stop: () => void }

function randomPort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") })
  const port = probe.port
  probe.stop(true)
  return port
}

async function spawnServer(extraEnv: Record<string, string> = {}): Promise<Handle> {
  const dataDir = mkdtempSync(join(tmpdir(), "mb-accept-data-"))
  const logFile = join(dataDir, "server.log")
  const seed = Bun.spawnSync({
    cmd: [BUN_BIN, "run", "seed"],
    cwd: TASK_DIR,
    env: { ...process.env, DATA_DIR: dataDir, PATH: CHILD_PATH },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (seed.exitCode !== 0) {
    throw new Error(
      `bun run seed exited ${seed.exitCode}\nstdout: ${seed.stdout.toString().slice(0, 1200)}\nstderr: ${seed.stderr.toString().slice(0, 1200)}`,
    )
  }
  const port = randomPort()
  const proc = Bun.spawn({
    cmd: ["bash", "-c", `exec ${JSON.stringify(BUN_BIN)} run start >> ${JSON.stringify(logFile)} 2>&1`],
    cwd: TASK_DIR,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PATH: CHILD_PATH,
      PORT: String(port),
      WEBHOOK_SECRET: SECRET,
      WEBHOOK_TOLERANCE_SECONDS: "300",
      RATE_LIMIT_PER_MINUTE: "100000",
      ...extraEnv,
    },
    stdin: "ignore",
  })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 40_000
  let up = false
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break
    try {
      const res = await fetch(`${base}/dashboard?account=acct_demo`)
      if (res.status > 0) {
        up = true
        break
      }
    } catch {
      // not listening yet
    }
    await Bun.sleep(150)
  }
  if (!up) {
    try {
      proc.kill()
    } catch {
      // already gone
    }
    let tail = ""
    try {
      tail = readFileSync(logFile, "utf8").slice(-2000)
    } catch {
      // no log
    }
    throw new Error(`server never became reachable on ${base}\n--- log tail ---\n${tail}`)
  }
  return {
    base,
    dataDir,
    logFile,
    stop: () => {
      try {
        proc.kill()
      } catch {
        // already gone
      }
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

const DEMO_AUTH = { authorization: "Bearer mb_test_demo_key", "content-type": "application/json" }
const JPY_AUTH = { authorization: "Bearer mb_test_jpy_key", "content-type": "application/json" }

type Reply = { status: number; headers: Headers; text: string; json: any }

async function call(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = DEMO_AUTH,
): Promise<Reply> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = undefined
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.status, headers: res.headers, text, json }
}

function expectProblem(r: Reply, status: number) {
  expect(r.status).toBe(status)
  expect((r.headers.get("content-type") ?? "").toLowerCase()).toContain("application/problem+json")
  expect(r.json, `body was not JSON: ${r.text.slice(0, 300)}`).toBeTruthy()
  expect(typeof r.json.type).toBe("string")
  expect(r.json.type.startsWith("https://errors.meterbase.dev/")).toBe(true)
  expect(typeof r.json.title).toBe("string")
  expect(r.json.title.length).toBeGreaterThan(0)
  expect(r.json.status).toBe(status)
  expect(typeof r.json.detail).toBe("string")
  expect(typeof r.json.instance).toBe("string")
}

function hmacHex(payload: string, timestamp: number, secret = SECRET): string {
  return createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex")
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

// Fixed billing periods, far from "now" so the wall clock never leaks in.
const P1 = { start: 1730000000, end: 1732000000 }
const P2 = { start: 1732000000, end: 1734000000 }
const P3 = { start: 1734000000, end: 1736000000 }
const P4 = { start: 1736000000, end: 1738000000 }

let srv: Handle

beforeAll(async () => {
  srv = await spawnServer()
})

afterAll(() => {
  srv?.stop()
})

test(
  "auth: missing token is an RFC 9457 problem with a 401",
  async () => {
    const r = await call(srv.base, "GET", "/v1/invoices", undefined, {})
    expectProblem(r, 401)
  },
  60_000,
)

test(
  "auth: unknown token gets an RFC 6750 section 3 bearer challenge",
  async () => {
    const r = await call(srv.base, "GET", "/v1/invoices", undefined, {
      authorization: "Bearer totally_unknown_key",
      "content-type": "application/json",
    })
    expectProblem(r, 401)
    const challenge = r.headers.get("www-authenticate") ?? ""
    expect(challenge).toMatch(/^Bearer\b/i)
    expect(challenge).toContain("realm=")
    expect(challenge).toContain('error="invalid_token"')
  },
  60_000,
)

test(
  "events: create returns an event and a replay is idempotent",
  async () => {
    const body = { meter: "api_calls", customer: "cus_alpha", quantity: 7, timestamp: P2.start + 10 }
    const first = await call(srv.base, "POST", "/v1/events", body, {
      ...DEMO_AUTH,
      "idempotency-key": "accept-replay-1",
    })
    expect(first.status).toBe(201)
    expect(first.json.object).toBe("event")
    expect(String(first.json.id)).toMatch(/^evt_/)
    expect(first.json.quantity).toBe(7)

    const replay = await call(srv.base, "POST", "/v1/events", body, {
      ...DEMO_AUTH,
      "idempotency-key": "accept-replay-1",
    })
    expect(replay.status).toBe(201)
    expect(replay.json).toEqual(first.json)
    expect((replay.headers.get("idempotent-replayed") ?? "").toLowerCase()).toBe("true")
  },
  120_000,
)

test(
  "events: reusing an idempotency key with another body is a 409",
  async () => {
    const key = "accept-reuse-1"
    const first = await call(
      srv.base,
      "POST",
      "/v1/events",
      { meter: "api_calls", customer: "cus_alpha", quantity: 1, timestamp: P2.start + 20 },
      { ...DEMO_AUTH, "idempotency-key": key },
    )
    expect(first.status).toBe(201)
    const conflicting = await call(
      srv.base,
      "POST",
      "/v1/events",
      { meter: "api_calls", customer: "cus_alpha", quantity: 2, timestamp: P2.start + 21 },
      { ...DEMO_AUTH, "idempotency-key": key },
    )
    expectProblem(conflicting, 409)
  },
  60_000,
)

test(
  "events: a missing Idempotency-Key is rejected as a problem, not a 500",
  async () => {
    const r = await call(srv.base, "POST", "/v1/events", {
      meter: "api_calls",
      customer: "cus_alpha",
      quantity: 1,
    })
    expectProblem(r, 400)
  },
  60_000,
)

test(
  "pricing: graduated tiers bill each band only for its own units",
  async () => {
    const events = [600, 600, 300]
    for (let i = 0; i < events.length; i += 1) {
      const r = await call(
        srv.base,
        "POST",
        "/v1/events",
        { meter: "api_calls", customer: "cus_alpha", quantity: events[i], timestamp: P1.start + 100 + i },
        { ...DEMO_AUTH, "idempotency-key": `accept-grad-${i}` },
      )
      expect(r.status).toBe(201)
    }
    const usage = await call(
      srv.base,
      "GET",
      `/v1/usage?meter=api_calls&customer=cus_alpha&from=${P1.start}&to=${P1.end}`,
    )
    expect(usage.status).toBe(200)
    expect(usage.json.object).toBe("usage")
    expect(usage.json.quantity).toBe(1500)
    // 1000 * 5 + 500 * 2 = 6000
    expect(usage.json.amount).toBe(6000)
    expect(usage.json.pricing_mode).toBe("graduated")
    expect(Array.isArray(usage.json.tiers)).toBe(true)
  },
  120_000,
)

test(
  "pricing: an invoice totals the graduated line item",
  async () => {
    const r = await call(srv.base, "POST", "/v1/invoices", {
      customer: "cus_alpha",
      period_start: P1.start,
      period_end: P1.end,
    })
    expect(r.status).toBe(201)
    expect(r.json.object).toBe("invoice")
    expect(String(r.json.id)).toMatch(/^inv_/)
    expect(r.json.currency).toBe("USD")
    expect(r.json.total).toBe(6000)
    expect(r.json.subtotal).toBe(6000)
    const line = (r.json.line_items ?? []).find((item: any) => item.meter === "api_calls")
    expect(line, "no api_calls line item").toBeTruthy()
    expect(line.amount).toBe(6000)
    expect(line.quantity).toBe(1500)
    expect(Array.isArray(line.tiers)).toBe(true)

    const replay = await call(srv.base, "POST", "/v1/invoices", {
      customer: "cus_alpha",
      period_start: P1.start,
      period_end: P1.end,
    })
    expect(replay.status).toBe(201)
    expect(replay.json.id).toBe(r.json.id)
  },
  120_000,
)

test(
  "pricing: volume tiers apply the landing rate to every unit",
  async () => {
    for (let i = 0; i < 2; i += 1) {
      const r = await call(
        srv.base,
        "POST",
        "/v1/events",
        { meter: "storage_gb", customer: "cus_beta", quantity: 75, timestamp: P1.start + 200 + i },
        { ...DEMO_AUTH, "idempotency-key": `accept-vol-${i}` },
      )
      expect(r.status).toBe(201)
    }
    const invoice = await call(srv.base, "POST", "/v1/invoices", {
      customer: "cus_beta",
      period_start: P1.start,
      period_end: P1.end,
    })
    expect(invoice.status).toBe(201)
    // 150 GB lands in the "null / 3" band, so all 150 units cost 3 cents each.
    expect(invoice.json.total).toBe(450)
    const line = (invoice.json.line_items ?? []).find((item: any) => item.meter === "storage_gb")
    expect(line, "no storage_gb line item").toBeTruthy()
    expect(line.pricing_mode).toBe("volume")
    expect(line.amount).toBe(450)
  },
  120_000,
)

test(
  "pricing: JPY is billed in whole yen, not cents",
  async () => {
    for (let i = 0; i < 2; i += 1) {
      const r = await call(
        srv.base,
        "POST",
        "/v1/events",
        { meter: "api_calls", customer: "cus_yen", quantity: 750, timestamp: P1.start + 300 + i },
        { ...JPY_AUTH, "idempotency-key": `accept-jpy-${i}` },
      )
      expect(r.status).toBe(201)
    }
    const invoice = await call(
      srv.base,
      "POST",
      "/v1/invoices",
      { customer: "cus_yen", period_start: P1.start, period_end: P1.end },
      JPY_AUTH,
    )
    expect(invoice.status).toBe(201)
    expect(invoice.json.currency).toBe("JPY")
    // 1000 * 5 + 500 * 2 = 6000 yen, no minor-unit scaling.
    expect(invoice.json.total).toBe(6000)
  },
  120_000,
)

test(
  "invoices: cursor pagination walks every page without duplicates or gaps",
  async () => {
    const periods = [P2, P3, P4]
    const created: string[] = []
    for (const period of periods) {
      const r = await call(srv.base, "POST", "/v1/invoices", {
        customer: "cus_beta",
        period_start: period.start,
        period_end: period.end,
      })
      expect(r.status).toBe(201)
      created.push(r.json.id)
    }

    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 20; page += 1) {
      const path: string = cursor
        ? `/v1/invoices?limit=2&starting_after=${encodeURIComponent(cursor)}`
        : "/v1/invoices?limit=2"
      const r: Reply = await call(srv.base, "GET", path)
      expect(r.status).toBe(200)
      expect(r.json.object).toBe("list")
      expect(Array.isArray(r.json.data)).toBe(true)
      expect(r.json.data.length).toBeLessThanOrEqual(2)
      expect(typeof r.json.has_more).toBe("boolean")
      for (const invoice of r.json.data) seen.push(invoice.id)
      if (!r.json.has_more) break
      cursor = r.json.next_cursor
      expect(typeof cursor).toBe("string")
    }
    expect(new Set(seen).size).toBe(seen.length)
    for (const id of created) expect(seen).toContain(id)
  },
  180_000,
)

test(
  "webhooks: sign emits the Stripe-compatible t/v1 scheme over t + '.' + payload",
  async () => {
    const payload = '{"id":"evt_1","amount":100}'
    const r = await call(srv.base, "POST", "/v1/webhooks/sign", { payload })
    expect(r.status).toBe(200)
    expect(typeof r.json.header).toBe("string")
    const parts: Record<string, string> = {}
    for (const piece of String(r.json.header).split(",")) {
      const index = piece.indexOf("=")
      expect(index).toBeGreaterThan(0)
      parts[piece.slice(0, index).trim()] = piece.slice(index + 1).trim()
    }
    expect(parts.t).toMatch(/^\d{10}$/)
    expect(parts.v1).toBe(hmacHex(payload, Number(parts.t)))
    expect(Math.abs(nowSeconds() - Number(parts.t))).toBeLessThan(120)
  },
  60_000,
)

test(
  "webhooks: verify accepts a correctly computed signature",
  async () => {
    const payload = '{"event":"invoice.paid","id":"inv_42"}'
    const t = nowSeconds()
    const r = await call(srv.base, "POST", "/v1/webhooks/verify", {
      payload,
      signature_header: `t=${t},v1=${hmacHex(payload, t)}`,
    })
    expect(r.status).toBe(200)
    expect(r.json.valid).toBe(true)
  },
  60_000,
)

test(
  "webhooks: verify rejects a signature from another secret",
  async () => {
    const payload = '{"event":"invoice.paid"}'
    const t = nowSeconds()
    const r = await call(srv.base, "POST", "/v1/webhooks/verify", {
      payload,
      signature_header: `t=${t},v1=${hmacHex(payload, t, "whsec_wrong_secret")}`,
    })
    expect(r.status).toBe(400)
    expect(r.json.valid).toBe(false)
  },
  60_000,
)

test(
  "webhooks: verify rejects a tampered payload",
  async () => {
    const original = '{"amount":100}'
    const tampered = '{"amount":999}'
    const t = nowSeconds()
    const r = await call(srv.base, "POST", "/v1/webhooks/verify", {
      payload: tampered,
      signature_header: `t=${t},v1=${hmacHex(original, t)}`,
    })
    expect(r.status).toBe(400)
    expect(r.json.valid).toBe(false)
  },
  60_000,
)

test(
  "webhooks: verify rejects a timestamp outside the tolerance window",
  async () => {
    const payload = '{"event":"old"}'
    const stale = nowSeconds() - 1000
    const r = await call(srv.base, "POST", "/v1/webhooks/verify", {
      payload,
      signature_header: `t=${stale},v1=${hmacHex(payload, stale)}`,
    })
    expect(r.status).toBe(400)
    expect(r.json.valid).toBe(false)
  },
  60_000,
)

test(
  "webhooks: verify accepts when any one v1 entry matches",
  async () => {
    const payload = '{"event":"rotated"}'
    const t = nowSeconds()
    const header = `t=${t},v1=${"0".repeat(64)},v1=${hmacHex(payload, t)}`
    const r = await call(srv.base, "POST", "/v1/webhooks/verify", { payload, signature_header: header })
    expect(r.status).toBe(200)
    expect(r.json.valid).toBe(true)
  },
  60_000,
)

test(
  "webhooks: verify rejects a header with no timestamp",
  async () => {
    const payload = '{"event":"unsigned"}'
    const t = nowSeconds()
    const r = await call(srv.base, "POST", "/v1/webhooks/verify", {
      payload,
      signature_header: `v1=${hmacHex(payload, t)}`,
    })
    expect(r.status).toBe(400)
    expect(r.json.valid).toBe(false)
  },
  60_000,
)

test(
  "ratelimit: RateLimit-* fields are present with delta-seconds reset",
  async () => {
    const limited = await spawnServer({ RATE_LIMIT_PER_MINUTE: "3" })
    try {
      const r = await call(limited.base, "GET", "/v1/invoices?limit=1")
      expect(r.status).toBe(200)
      expect(r.headers.get("ratelimit-limit")).toBe("3")
      const remaining = Number(r.headers.get("ratelimit-remaining"))
      expect(Number.isInteger(remaining)).toBe(true)
      expect(remaining).toBeGreaterThanOrEqual(0)
      expect(remaining).toBeLessThanOrEqual(3)
      const reset = Number(r.headers.get("ratelimit-reset"))
      expect(Number.isInteger(reset)).toBe(true)
      expect(reset).toBeGreaterThanOrEqual(0)
      expect(reset).toBeLessThanOrEqual(60)
    } finally {
      limited.stop()
    }
  },
  120_000,
)

test(
  "ratelimit: exceeding the window returns 429 problem details with Retry-After",
  async () => {
    const limited = await spawnServer({ RATE_LIMIT_PER_MINUTE: "3" })
    try {
      let limited429: Reply | undefined
      for (let i = 0; i < 8; i += 1) {
        const r = await call(limited.base, "GET", "/v1/invoices?limit=1")
        if (r.status === 429) {
          limited429 = r
          break
        }
        expect(r.status).toBe(200)
      }
      expect(limited429, "no 429 after 8 requests with a limit of 3").toBeTruthy()
      expectProblem(limited429!, 429)
      const retryAfter = limited429!.headers.get("retry-after")
      expect(retryAfter).toBeTruthy()
      expect(Number(retryAfter)).toBeGreaterThanOrEqual(0)
    } finally {
      limited.stop()
    }
  },
  120_000,
)

test(
  "dashboard: server-rendered HTML lists invoices without JavaScript",
  async () => {
    const r = await call(srv.base, "GET", "/dashboard?account=acct_demo", undefined, {})
    expect(r.status).toBe(200)
    expect((r.headers.get("content-type") ?? "").toLowerCase()).toContain("text/html")
    expect(r.text).toContain("acct_demo")
    expect(r.text).toMatch(/inv_/)
  },
  60_000,
)
