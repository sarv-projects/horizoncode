/**
 * METERBASE — visible acceptance subset (written from TASK.md, black box).
 *
 * These are the contracts the implementing agent must satisfy; they are expected
 * to be red against the skeleton (which answers 501 everywhere) and green when
 * TASK.md is implemented. They intentionally check wire contracts only — status
 * codes, problem-details members, exact response field names, idempotency
 * semantics, pagination shape, HTML — never internal names or table layouts.
 *
 * Do not weaken these tests; add more of your own instead.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SEEDED_JPY_KEY, auth, postJson, startServer, type ServerHandle } from './helpers';

/** Billing period used by the invoice tests: 2024-11-01T00:00:00Z .. 2024-12-01T00:00:00Z. */
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

/** Assert an RFC 9457 problem-details response body (TASK.md "### Errors"). */
function expectProblem(body: any, status: number): void {
  for (const member of ['type', 'title', 'status', 'detail', 'instance']) {
    expect(body).toHaveProperty(member);
  }
  expect(body.status).toBe(status);
  expect(typeof body.type).toBe('string');
  expect(body.type).toMatch(/^https:\/\/errors\.meterbase\.dev\//);
  expect(typeof body.title).toBe('string');
  expect(typeof body.detail).toBe('string');
  expect(typeof body.instance).toBe('string');
}

describe('auth (RFC 6750)', () => {
  test('GET /v1/invoices without a token -> 401 application/problem+json', async () => {
    const res = await srv.request('/v1/invoices');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type') ?? '').toContain('application/problem+json');
    const body: any = await res.json();
    expectProblem(body, 401);
    expect(body.instance).toContain('/v1/invoices');
  });

  test('the 401 challenge is RFC 6750 §3 compliant (missing and unknown tokens)', async () => {
    const responses = [
      await srv.request('/v1/invoices'),
      await srv.request('/v1/invoices', { headers: auth('mb_test_not_a_real_key') }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(401);
      await res.arrayBuffer();
      const challenge = res.headers.get('www-authenticate') ?? '';
      expect(challenge.toLowerCase().startsWith('bearer')).toBe(true);
      expect(challenge).toContain('realm=');
      expect(challenge).toMatch(/error="invalid_token"/);
      expect(challenge).toMatch(/error_description="[^"]+"/);
    }
  });
});

describe('rate limiting (IETF RateLimit-* headers)', () => {
  test('an authenticated /v1/ response exposes Limit, Remaining and Reset', async () => {
    const res = await srv.request('/v1/invoices?limit=1', { headers: auth() });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    for (const name of ['ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset']) {
      const raw = res.headers.get(name);
      expect(raw).not.toBeNull();
      expect(Number.isInteger(Number(raw))).toBe(true);
      expect(Number(raw)).toBeGreaterThanOrEqual(0);
    }
    expect(Number(res.headers.get('ratelimit-remaining'))).toBeLessThanOrEqual(
      Number(res.headers.get('ratelimit-limit')),
    );
  });
});

describe('POST /v1/events', () => {
  test('ingests an event and replays the identical response for the same key', async () => {
    const key = `smoke-evt-${crypto.randomUUID()}`;
    const payload = {
      meter: 'api_calls',
      customer: 'cus_beta',
      quantity: 7,
      timestamp: IN_PERIOD,
    };
    const send = (): Promise<Response> =>
      postJson(srv, '/v1/events', payload, { ...auth(), 'Idempotency-Key': key });

    const first = await send();
    expect(first.status).toBe(201);
    const firstBody: any = await first.json();
    expect(firstBody.object).toBe('event');
    expect(typeof firstBody.id).toBe('string');
    expect(firstBody.id.startsWith('evt_')).toBe(true);
    expect(firstBody.meter).toBe('api_calls');
    expect(firstBody.customer).toBe('cus_beta');
    expect(firstBody.quantity).toBe(7);
    expect(firstBody.timestamp).toBe(IN_PERIOD);

    const replay = await send();
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.headers.get('content-type') ?? '').toContain('application/json');
    expect(await replay.json()).toEqual(firstBody);
  });

  test('the same Idempotency-Key with a different body -> 409 problem+json', async () => {
    const key = `smoke-evt-conflict-${crypto.randomUUID()}`;
    const payload = {
      meter: 'api_calls',
      customer: 'cus_alpha',
      quantity: 1,
      timestamp: IN_PERIOD + 1,
    };
    const first = await postJson(srv, '/v1/events', payload, { ...auth(), 'Idempotency-Key': key });
    expect(first.status).toBe(201);
    await first.arrayBuffer();

    const conflict = await postJson(
      srv,
      '/v1/events',
      { ...payload, quantity: 2 },
      { ...auth(), 'Idempotency-Key': key },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get('content-type') ?? '').toContain('application/problem+json');
    expectProblem(await conflict.json(), 409);
  });
});

describe('GET /v1/usage', () => {
  test('aggregates quantity and returns the graduated tier breakdown (exact shape)', async () => {
    const ingest = await postJson(
      srv,
      '/v1/events',
      { meter: 'api_calls', customer: 'cus_yen', quantity: 1500, timestamp: IN_PERIOD },
      { ...auth(SEEDED_JPY_KEY), 'Idempotency-Key': `smoke-usage-${crypto.randomUUID()}` },
    );
    expect(ingest.status).toBe(201);
    await ingest.arrayBuffer();

    const res = await srv.request(
      `/v1/usage?meter=api_calls&customer=cus_yen&from=${PERIOD_START}&to=${PERIOD_END}`,
      { headers: auth(SEEDED_JPY_KEY) },
    );
    expect(res.status).toBe(200);
    const usage: any = await res.json();

    expect(usage.object).toBe('usage');
    expect(usage.meter).toBe('api_calls');
    expect(usage.customer).toBe('cus_yen');
    expect(usage.pricing_mode).toBe('graduated');
    expect(usage.quantity).toBe(1500);
    // JPY has exponent 0, so 1000×5 + 500×2 = 6000 minor units = ¥6000.
    expect(Number.isInteger(usage.amount)).toBe(true);
    expect(usage.amount).toBe(6000);
    expect(Array.isArray(usage.tiers)).toBe(true);
    expect(usage.tiers.map((t: any) => [t.units, t.unit_amount, t.amount])).toEqual([
      [1000, 5, 5000],
      [500, 2, 1000],
    ]);
  });
});

describe('POST /v1/invoices', () => {
  test('creates an invoice in the exact shape from TASK.md and is idempotent per period', async () => {
    const ingest = await postJson(
      srv,
      '/v1/events',
      { meter: 'api_calls', customer: 'cus_alpha', quantity: 1500, timestamp: IN_PERIOD },
      { ...auth(), 'Idempotency-Key': `smoke-inv-evt-${crypto.randomUUID()}` },
    );
    expect(ingest.status).toBe(201);
    await ingest.arrayBuffer();

    const request = { customer: 'cus_alpha', period_start: PERIOD_START, period_end: PERIOD_END };
    const res = await postJson(srv, '/v1/invoices', request, auth());
    expect(res.status).toBe(201);
    const invoice: any = await res.json();

    expect(invoice.object).toBe('invoice');
    expect(typeof invoice.id).toBe('string');
    expect(invoice.id.startsWith('inv_')).toBe(true);
    expect(invoice.customer).toBe('cus_alpha');
    expect(invoice.currency).toBe('USD');
    expect(invoice.period_start).toBe(PERIOD_START);
    expect(invoice.period_end).toBe(PERIOD_END);
    expect(typeof invoice.status).toBe('string');
    expect(Number.isInteger(invoice.subtotal)).toBe(true);
    expect(Number.isInteger(invoice.total)).toBe(true);
    expect(invoice.total).toBe(invoice.subtotal);

    expect(Array.isArray(invoice.line_items)).toBe(true);
    const lines = invoice.line_items as any[];
    expect(lines.length).toBeGreaterThan(0);

    const apiLine = lines.find((line) => line.meter === 'api_calls');
    expect(apiLine).toBeDefined();
    expect(apiLine.pricing_mode).toBe('graduated');
    expect(apiLine.quantity).toBeGreaterThanOrEqual(1500);

    let sumOfLines = 0;
    for (const line of lines) {
      expect(typeof line.meter).toBe('string');
      expect(Number.isInteger(line.quantity)).toBe(true);
      expect(Number.isInteger(line.amount)).toBe(true);
      expect(['graduated', 'volume']).toContain(line.pricing_mode);
      expect(Array.isArray(line.tiers)).toBe(true);

      let sumOfTiers = 0;
      for (const tier of line.tiers as any[]) {
        expect(tier.up_to === null || Number.isInteger(tier.up_to)).toBe(true);
        expect(Number.isInteger(tier.units)).toBe(true);
        expect(Number.isInteger(tier.unit_amount)).toBe(true);
        expect(Number.isInteger(tier.amount)).toBe(true);
        // TASK.md: "A tier row's amount is units * unit_amount".
        expect(tier.amount).toBe(tier.units * tier.unit_amount);
        sumOfTiers += tier.amount;
      }
      expect(sumOfTiers).toBe(line.amount);
      sumOfLines += line.amount;
    }
    // TASK.md: subtotal/total are the sum of the line-item amounts (no tax).
    expect(sumOfLines).toBe(invoice.total);

    // Idempotent per (customer, period_start, period_end): same 201 and same body.
    const again = await postJson(srv, '/v1/invoices', request, auth());
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(invoice);
  });
});

describe('GET /v1/invoices', () => {
  test('returns a Stripe-style page: object=list, data, boolean has_more, next_cursor', async () => {
    const res = await srv.request('/v1/invoices?limit=1', { headers: auth() });
    expect(res.status).toBe(200);
    const page: any = await res.json();
    expect(page.object).toBe('list');
    expect(Array.isArray(page.data)).toBe(true);
    expect(page.data.length).toBeLessThanOrEqual(1);
    expect(typeof page.has_more).toBe('boolean');
    expect(page).toHaveProperty('next_cursor');

    if (page.has_more) {
      expect(typeof page.next_cursor).toBe('string');
      const next = await srv.request(
        `/v1/invoices?limit=1&starting_after=${encodeURIComponent(page.next_cursor)}`,
        { headers: auth() },
      );
      expect(next.status).toBe(200);
      const nextPage: any = await next.json();
      expect(nextPage.object).toBe('list');
      const nextIds = new Set((nextPage.data as any[]).map((item) => item.id));
      for (const item of page.data as any[]) {
        expect(nextIds.has(item.id)).toBe(false);
      }
    }
  });
});

describe('webhooks (Stripe-compatible signatures)', () => {
  test('sign -> verify round-trips to {valid:true}', async () => {
    const payload = JSON.stringify({ id: 'evt_smoke', amount: 4200, currency: 'usd' });
    const signRes = await postJson(srv, '/v1/webhooks/sign', { payload }, auth());
    expect(signRes.status).toBe(200);
    const signed: any = await signRes.json();
    expect(typeof signed.header).toBe('string');
    expect(signed.header).toMatch(/(?:^|,)t=\d+/);
    expect(signed.header).toMatch(/v1=[0-9a-f]{64}/);

    const verifyRes = await postJson(
      srv,
      '/v1/webhooks/verify',
      { payload, signature_header: signed.header },
      auth(),
    );
    expect(verifyRes.status).toBe(200);
    const verified: any = await verifyRes.json();
    expect(verified.valid).toBe(true);
  });

  test('a tampered payload -> 400 problem+json with valid:false and a reason', async () => {
    const payload = JSON.stringify({ id: 'evt_smoke', amount: 4200 });
    const signRes = await postJson(srv, '/v1/webhooks/sign', { payload }, auth());
    const signed: any = await signRes.json();

    const verifyRes = await postJson(
      srv,
      '/v1/webhooks/verify',
      {
        payload: JSON.stringify({ id: 'evt_smoke', amount: 999999 }),
        signature_header: signed.header,
      },
      auth(),
    );
    expect(verifyRes.status).toBe(400);
    expect(verifyRes.headers.get('content-type') ?? '').toContain('application/problem+json');
    const body: any = await verifyRes.json();
    expect(body.valid).toBe(false);
    expect(typeof body.reason).toBe('string');
    expectProblem(body, 400);
  });
});

describe('dashboard', () => {
  test('GET /dashboard?account=acct_demo renders HTML without a build step', async () => {
    const res = await srv.request('/dashboard?account=acct_demo');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    const html = await res.text();
    expect(html).toContain('acct_demo');
    expect(html.toLowerCase()).toContain('<html');
  });
});
