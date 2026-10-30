/**
 * Meterbase — acceptance tests beyond the visible smoke suite.
 *
 * Black box: talks HTTP to a real server process, seeded fresh per file.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  ROOT,
  SEEDED_JPY_KEY,
  auth,
  freePort,
  postJson,
  runSeed,
  startServer,
  type ServerHandle,
} from './helpers';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PERIOD_START = 1730419200;
const PERIOD_END = 1733011200;
const IN_PERIOD = 1730500000;

let srv!: ServerHandle;

beforeAll(async () => {
  srv = await startServer();
}, 30_000);

afterAll(async () => {
  if (srv) await srv.stop();
});

function expectProblem(body: unknown, status: number): void {
  const b: any = body;
  expect(typeof b.type).toBe('string');
  expect(b.type).toMatch(/^https:\/\/errors\.meterbase\.dev\//);
  expect(typeof b.title).toBe('string');
  expect(b.status).toBe(status);
  expect(typeof b.detail).toBe('string');
  expect(typeof b.instance).toBe('string');
}

describe('dashboard empty state', () => {
  test('GET /dashboard?account=acct_demo shows no invoices before any exist', async () => {
    const res = await srv.request('/dashboard?account=acct_demo');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    const html = await res.text();
    expect(html).toContain('acct_demo');
    expect(html.toLowerCase()).toContain('<html');
    expect(html).toContain('No invoices yet');
    expect(html).toContain('Current-period usage');
  });
});

describe('pricing — volume mode', () => {
  test('all units priced at the tier the total lands in', async () => {
    const key = `vol-150-${crypto.randomUUID()}`;
    const ingest = await postJson(
      srv,
      '/v1/events',
      { meter: 'storage_gb', customer: 'cus_beta', quantity: 150, timestamp: IN_PERIOD },
      { ...auth(), 'Idempotency-Key': key },
    );
    expect(ingest.status).toBe(201);

    const usage = await srv.request(
      `/v1/usage?meter=storage_gb&customer=cus_beta&from=${PERIOD_START}&to=${PERIOD_END}`,
      { headers: auth() },
    );
    const body: any = await usage.json();
    expect(body.object).toBe('usage');
    expect(body.quantity).toBe(150);
    expect(body.pricing_mode).toBe('volume');
    expect(body.amount).toBe(450); // 150 x 3 (second tier, 100 < 150)
    expect(body.tiers.map((t: any) => [t.units, t.unit_amount, t.amount])).toEqual([
      [0, 10, 0],
      [150, 3, 450],
    ]);
  });

  test('volume tier boundary is inclusive: 100 GB stays in the first tier', async () => {
    const key = `vol-100-${crypto.randomUUID()}`;
    await postJson(
      srv,
      '/v1/events',
      { meter: 'storage_gb', customer: 'cus_alpha', quantity: 100, timestamp: IN_PERIOD },
      { ...auth(), 'Idempotency-Key': key },
    );
    const usage = await srv.request(
      `/v1/usage?meter=storage_gb&customer=cus_alpha&from=${PERIOD_START}&to=${PERIOD_END}`,
      { headers: auth() },
    );
    const body: any = await usage.json();
    expect(body.amount).toBe(1000); // 100 x 10
    expect(body.tiers.map((t: any) => [t.units, t.amount])).toEqual([
      [100, 1000],
      [0, 0],
    ]);
  });

  test('graduated below the first tier boundary', async () => {
    const key = `vol-42-${crypto.randomUUID()}`;
    await postJson(
      srv,
      '/v1/events',
      { meter: 'api_calls', customer: 'cus_beta', quantity: 42, timestamp: IN_PERIOD },
      { ...auth(), 'Idempotency-Key': key },
    );
    const usage = await srv.request(
      `/v1/usage?meter=api_calls&customer=cus_beta&from=${PERIOD_START}&to=${PERIOD_END}`,
      { headers: auth() },
    );
    const body: any = await usage.json();
    expect(body.amount).toBe(210); // 42 x 5
    expect(body.tiers.map((t: any) => [t.units, t.amount])).toEqual([[42, 210], [0, 0]]);
  });
});

describe('invoices', () => {
  test('volume invoice line item and idempotent replay', async () => {
    // cus_alpha already has 100 GB of storage_gb from the boundary test; this adds
    // 50 more (150 total, all in the second volume tier) -> 450 minor units.
    const key = `inv-vol-evt-${crypto.randomUUID()}`;
    await postJson(
      srv,
      '/v1/events',
      { meter: 'storage_gb', customer: 'cus_alpha', quantity: 50, timestamp: IN_PERIOD },
      { ...auth(), 'Idempotency-Key': key },
    );

    const request = { customer: 'cus_alpha', period_start: PERIOD_START, period_end: PERIOD_END };
    const res = await postJson(srv, '/v1/invoices', request, auth());
    expect(res.status).toBe(201);
    const invoice: any = await res.json();
    expect(invoice.subtotal).toBe(450);
    expect(invoice.total).toBe(450);
    const line = invoice.line_items.find((l: any) => l.meter === 'storage_gb');
    expect(line).toBeDefined();
    expect(line.amount).toBe(450);
    expect(line.tiers.map((t: any) => t.amount).reduce((a: number, b: number) => a + b, 0)).toBe(450);

    const again = await postJson(srv, '/v1/invoices', request, auth());
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(invoice);
  });

  test('JPY invoice respects the zero exponent (no fractional minor units)', async () => {
    const key = `inv-jpy-evt-${crypto.randomUUID()}`;
    await postJson(
      srv,
      '/v1/events',
      { meter: 'api_calls', customer: 'cus_yen', quantity: 1500, timestamp: IN_PERIOD },
      { ...auth(SEEDED_JPY_KEY), 'Idempotency-Key': key },
    );

    const request = { customer: 'cus_yen', period_start: PERIOD_START, period_end: PERIOD_END };
    const res = await postJson(srv, '/v1/invoices', request, auth(SEEDED_JPY_KEY));
    expect(res.status).toBe(201);
    const invoice: any = await res.json();
    expect(invoice.currency).toBe('JPY');
    expect(invoice.subtotal).toBe(6000);
    expect(invoice.total).toBe(6000);
    expect(Number.isInteger(invoice.subtotal)).toBe(true);
  });

  test('invoice for unknown customer -> 400', async () => {
    const res = await postJson(
      srv,
      '/v1/invoices',
      { customer: 'cus_ghost', period_start: PERIOD_START, period_end: PERIOD_END },
      auth(),
    );
    expect(res.status).toBe(400);
    expectProblem(await res.json(), 400);
  });

  test('invoice with period_end <= period_start -> 400', async () => {
    const res = await postJson(
      srv,
      '/v1/invoices',
      { customer: 'cus_alpha', period_start: 1733011200, period_end: 1730419200 },
      auth(),
    );
    expect(res.status).toBe(400);
    expectProblem(await res.json(), 400);
  });
});

describe('events validation', () => {
  test('missing Idempotency-Key -> 400 problem', async () => {
    const res = await postJson(
      srv,
      '/v1/events',
      { meter: 'api_calls', customer: 'cus_alpha', quantity: 1, timestamp: IN_PERIOD },
      auth(),
    );
    expect(res.status).toBe(400);
    expectProblem(await res.json(), 400);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('application/problem+json');
  });

  test('unknown meter -> 400; unknown customer -> 400; negative quantity -> 400', async () => {
    const base = { ...auth(), 'Idempotency-Key': `val-${crypto.randomUUID()}` };
    const a = await postJson(
      srv, '/v1/events', { meter: 'nope', customer: 'cus_alpha', quantity: 1 }, base,
    );
    expect(a.status).toBe(400);
    expectProblem(await a.json(), 400);

    const b = await postJson(
      srv, '/v1/events', { meter: 'api_calls', customer: 'cus_ghost', quantity: 1 },
      { ...base, 'Idempotency-Key': `val2-${crypto.randomUUID()}` },
    );
    expect(b.status).toBe(400);
    expectProblem(await b.json(), 400);

    const c = await postJson(
      srv, '/v1/events', { meter: 'api_calls', customer: 'cus_alpha', quantity: -3 },
      { ...auth(), 'Idempotency-Key': `val3-${crypto.randomUUID()}` },
    );
    expect(c.status).toBe(400);
    expectProblem(await c.json(), 400);
  });

  test('timestamp defaults to now when omitted', async () => {
    const before = Math.floor(Date.now() / 1000);
    const key = `ts-default-${crypto.randomUUID()}`;
    const res = await postJson(
      srv,
      '/v1/events',
      { meter: 'api_calls', customer: 'cus_alpha', quantity: 3 },
      { ...auth(), 'Idempotency-Key': key },
    );
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(Number.isInteger(body.timestamp)).toBe(true);
    expect(body.timestamp).toBeGreaterThanOrEqual(before);
    expect(body.timestamp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
  });

  test('usage from/to filter excludes out-of-range events', async () => {
    const key = `ts-filter-${crypto.randomUUID()}`;
    await postJson(
      srv,
      '/v1/events',
      { meter: 'api_calls', customer: 'cus_alpha', quantity: 9, timestamp: 1730500001 },
      { ...auth(), 'Idempotency-Key': key },
    );
    const res = await srv.request(
      `/v1/usage?meter=api_calls&customer=cus_alpha&from=1730500002&to=1733011200`,
      { headers: auth() },
    );
    const body: any = await res.json();
    expect(body.quantity).toBe(0);
    expect(body.amount).toBe(0);
  });
});

describe('invoice list pagination', () => {
  test('stable cursor pagination over many invoices: no duplicates, no gaps', async () => {
    // Create 25 invoices for cus_alpha across distinct periods.
    // Baseline: invoices created by earlier tests in this file also belong to acct_demo.
    const baselineRes = await srv.request('/v1/invoices?limit=100', { headers: auth() });
    const baseline: any = await baselineRes.json();
    const baselineCount = baseline.data.length;

    for (let i = 0; i < 25; i++) {
      await postJson(
        srv,
        '/v1/invoices',
        {
          customer: 'cus_alpha',
          period_start: PERIOD_START + i * 86_400,
          period_end: PERIOD_START + (i + 1) * 86_400,
        },
        auth(),
      );
    }

    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const url = cursor
        ? `/v1/invoices?limit=5&starting_after=${encodeURIComponent(cursor)}`
        : '/v1/invoices?limit=5';
      const res = await srv.request(url, { headers: auth() });
      expect(res.status).toBe(200);
      const page: any = await res.json();
      expect(page.object).toBe('list');
      expect(Array.isArray(page.data)).toBe(true);
      expect(typeof page.has_more).toBe('boolean');
      for (const item of page.data) {
        ids.push(item.id);
        expect(item.subtotal).toBeDefined();
        expect(item.total).toBeDefined();
      }
      pages++;
      if (!page.has_more) {
        expect(page.next_cursor).toBeNull();
        break;
      }
      expect(typeof page.next_cursor).toBe('string');
      cursor = page.next_cursor;
      if (pages > 100) throw new Error('pagination loop');
    }
    expect(ids.length).toBe(baselineCount + 25);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates

    // Walking the cursors must reproduce the same ordered set without gaps.
    const direct: any = await (await srv.request('/v1/invoices?limit=100', { headers: auth() })).json();
    const directIds = (direct.data as any[]).map((item) => item.id);
    expect(directIds).toEqual(ids);
  });

  test('invalid limit and invalid cursor -> 400 problem', async () => {
    const badLimit = await srv.request('/v1/invoices?limit=abc', { headers: auth() });
    expect(badLimit.status).toBe(400);
    expectProblem(await badLimit.json(), 400);

    const badCursor = await srv.request(
      '/v1/invoices?starting_after=not-a-cursor',
      { headers: auth() },
    );
    expect(badCursor.status).toBe(400);
    expectProblem(await badCursor.json(), 400);
  });
});

describe('webhooks', () => {
  test('verify rejects a signature whose timestamp is outside tolerance', async () => {
    const secret = 'whsec_smoke_secret';
    const old = Math.floor(Date.now() / 1000) - 400; // outside the 300 s tolerance
    const sig = await signWith(secret, 'payload-x', old);
    const res = await postJson(
      srv,
      '/v1/webhooks/verify',
      { payload: 'payload-x', signature_header: sig },
      auth(),
    );
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('timestamp_outside_tolerance');
    expectProblem(body, 400);
  });

  test('verify rejects a header with no valid signature', async () => {
    const res = await postJson(
      srv,
      '/v1/webhooks/verify',
      { payload: 'payload-y', signature_header: 't=1,v1=' + '0'.repeat(64) },
      auth(),
    );
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.valid).toBe(false);
    expect(typeof body.reason).toBe('string');
    expectProblem(body, 400);
  });

  test('sign accepts any payload string', async () => {
    const res = await postJson(srv, '/v1/webhooks/sign', { payload: 'not-json-at-all' }, auth());
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(typeof body.header).toBe('string');
    expect(body.header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });
});

async function signWith(secret: string, payload: string, timestamp: number): Promise<string> {
  const { createHmac } = await import('node:crypto');
  const sig = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

describe('rate limiting', () => {
  test('exceeding the per-minute limit -> 429 with Retry-After', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'meterbase-ratelimit-'));
    runSeed(dataDir);
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const child = Bun.spawn({
      cmd: [process.execPath, 'run', join(ROOT, 'src/index.ts')],
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dataDir,
        WEBHOOK_SECRET: 'whsec_smoke_secret',
        WEBHOOK_TOLERANCE_SECONDS: '300',
        RATE_LIMIT_PER_MINUTE: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stop = async () => {
      try { child.kill(); } catch {}
      await Promise.race([child.exited, new Promise((r) => setTimeout(r, 5_000))]);
      rmSync(dataDir, { recursive: true, force: true });
    };

    try {
      // Wait for readiness.
      let ready = false;
      for (let i = 0; i < 200 && !ready; i++) {
        try {
          const p = await fetch(`${base}/__ready__`);
          await p.arrayBuffer();
          ready = true;
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      expect(ready).toBe(true);

      const first = await fetch(`${base}/v1/invoices`, {
        headers: { authorization: 'Bearer mb_test_demo_key' },
      });
      expect(first.status).toBe(200);
      expect(first.headers.get('ratelimit-limit')).toBe('1');
      expect(Number(first.headers.get('ratelimit-remaining'))).toBeLessThanOrEqual(1);

      const second = await fetch(`${base}/v1/invoices`, {
        headers: { authorization: 'Bearer mb_test_demo_key' },
      });
      expect(second.status).toBe(429);
      const body: any = await second.json();
      expectProblem(body, 429);
      expect(second.headers.get('retry-after')).not.toBeNull();
      expect(Number(second.headers.get('ratelimit-remaining'))).toBe(0);
    } finally {
      await stop();
    }
  });
});

describe('dashboard', () => {
  test('renders the JPY invoice with zero-exponent formatting', async () => {
    // The JPY invoice test created an invoice on acct_jpy; the dashboard must
    // format ¥6000 with exponent 0 (no decimal places).
    const res = await srv.request('/dashboard?account=acct_jpy');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('acct_jpy');
    expect(html).toContain('¥6000');
    expect(html).toContain('Current-period usage');
  });

  test('lists created invoices with formatted totals', async () => {
    const evtKey = `dash-evt-${crypto.randomUUID()}`;
    await postJson(
      srv,
      '/v1/events',
      { meter: 'api_calls', customer: 'cus_alpha', quantity: 1500, timestamp: 1733100000 },
      { ...auth(), 'Idempotency-Key': evtKey },
    );
    await postJson(
      srv,
      '/v1/invoices',
      { customer: 'cus_alpha', period_start: 1733011200, period_end: 1735689600 },
      auth(),
    );

    const res = await srv.request('/dashboard?account=acct_demo');
    const html = await res.text();
    expect(html).toContain('$60.00');
    expect(html).toContain('inv_');
    expect(html).toContain('api_calls');
  });

  test('unknown account -> 404 problem; missing account -> 400 problem', async () => {
    const missing = await srv.request('/dashboard');
    expect(missing.status).toBe(400);
    expectProblem(await missing.json(), 400);

    const unknown = await srv.request('/dashboard?account=acct_ghost');
    expect(unknown.status).toBe(404);
    expectProblem(await unknown.json(), 404);
  });
});

describe('process restart persistence', () => {
  test('survives a server restart with the same DATA_DIR', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'meterbase-persist-'));
    runSeed(dataDir);
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const authH = { authorization: 'Bearer mb_test_demo_key' };

    const spawnServer = async (p: number) => {
      return Bun.spawn({
        cmd: [process.execPath, 'run', join(ROOT, 'src/index.ts')],
        cwd: ROOT,
        env: {
          ...process.env,
          PORT: String(p),
          DATA_DIR: dataDir,
          WEBHOOK_SECRET: 'whsec_smoke_secret',
          WEBHOOK_TOLERANCE_SECONDS: '300',
          RATE_LIMIT_PER_MINUTE: '1000',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
    };

    const stop = async (child: unknown) => {
      try { (child as Bun.Subprocess).kill(); } catch {}
      await Promise.race([(child as Bun.Subprocess).exited, new Promise((r) => setTimeout(r, 5_000))]);
    };

    const ready = async (child: unknown) => {
      for (let i = 0; i < 200; i++) {
        try {
          const p = await fetch(`${base}/__ready__`);
          await p.arrayBuffer();
          return;
        } catch {
          if ((child as Bun.Subprocess).exitCode !== null) throw new Error('server exited');
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      throw new Error('server not ready');
    };

    const child1 = await spawnServer(port);
    await ready(child1);
    const key = `persist-${crypto.randomUUID()}`;
    const ingest = await fetch(`${base}/v1/events`, {
      method: 'POST',
      headers: { ...authH, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ meter: 'api_calls', customer: 'cus_alpha', quantity: 42, timestamp: IN_PERIOD }),
    });
    expect(ingest.status).toBe(201);
    await stop(child1);

    const child2 = await spawnServer(port);
    await ready(child2);
    const usage = await fetch(`${base}/v1/usage?meter=api_calls&customer=cus_alpha&from=0&to=9999999999`, {
      headers: authH,
    });
    expect(usage.status).toBe(200);
    const body: any = await usage.json();
    expect(body.quantity).toBe(42);
    await stop(child2);
    rmSync(dataDir, { recursive: true, force: true });
  });
});
