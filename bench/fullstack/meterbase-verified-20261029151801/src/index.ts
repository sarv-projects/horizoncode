/**
 * Meterbase — HTTP entrypoint.
 *
 * Implements the contract in TASK.md:
 *   - RFC 6750 bearer auth on /v1/ (WWW-Authenticate challenge, 401)
 *   - POST /v1/events with Idempotency-Key replay / 409 conflict semantics
 *   - GET /v1/usage aggregation with graduated / volume tier breakdowns
 *   - POST /v1/invoices, idempotent per (customer, period_start, period_end)
 *   - GET /v1/invoices with Stripe-style cursor pagination
 *   - POST /v1/webhooks/sign + /v1/webhooks/verify (Stripe-compatible signatures)
 *   - RFC 9457 problem details for every error, IETF RateLimit-* headers,
 *     429 with Retry-After
 *   - Server-rendered GET /dashboard (public, works without JavaScript)
 *
 * Storage: bun:sqlite against $DATA_DIR/meterbase.db (schema from src/seed.ts).
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { SCHEMA_SQL } from './seed.ts';
import { currencyExponent, formatMinorUnits } from './currency.ts';
import { priceMeter, type Tier } from './pricing.ts';

/** Error `type` base for this service; every problem response uses a URI under it. */
export const ERROR_BASE = 'https://errors.meterbase.dev/';

/** Persistence root: `DATA_DIR` (default `./.data`), created on boot. */
export const DATA_DIR = resolve(process.env.DATA_DIR ?? './.data');

/** SQLite file produced by `bun run seed` (see docs/SCHEMA.md). */
export const DB_PATH = resolve(DATA_DIR, 'meterbase.db');

mkdirSync(DATA_DIR, { recursive: true });

function configuredPort(): number {
  const raw = process.env.PORT;
  const parsed = raw === undefined || raw === '' ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 8787;
}

const PORT = configuredPort();
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? '';
const WEBHOOK_TOLERANCE_SECONDS =
  Number.parseInt(process.env.WEBHOOK_TOLERANCE_SECONDS ?? '300', 10) || 300;
const RATE_LIMIT_PER_MINUTE =
  Number.parseInt(process.env.RATE_LIMIT_PER_MINUTE ?? '120', 10) || 120;

const REALM = 'meterbase';
const EVENTS_ENDPOINT = 'POST /v1/events';
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export interface Account {
  id: string;
  api_key: string;
  name: string;
  currency: string;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
}

export interface RouteOut {
  status: number;
  contentType: string;
  body: string;
  headers?: Record<string, string>;
}

interface RateInfo {
  limit: number;
  remaining: number;
  reset: number;
  exceeded: boolean;
}

/** Open (or create) the database and make sure the schema exists. */
function openDb(): Database {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  const hasMeta = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!hasMeta) {
    // Fresh database: install the canonical schema from the seed module.
    db.exec(SCHEMA_SQL);
  }
  return db;
}

const db = openDb();

// ---------------------------------------------------------------------------
// Problem details (RFC 9457)
// ---------------------------------------------------------------------------

/**
 * Build an RFC 9457 problem-details response. `type` is a URI under
 * https://errors.meterbase.dev/. `instance` is the request path.
 */
function problem(
  status: number,
  type: string,
  title: string,
  detail: string,
  instance: string,
  headers: Record<string, string> = {},
  extra: Record<string, unknown> = {},
): RouteOut {
  const body: Record<string, unknown> = { type, title, status, detail, instance, ...extra };
  return {
    status,
    contentType: 'application/problem+json; charset=utf-8',
    body: JSON.stringify(body),
    headers,
  };
}

function jsonBody(status: number, value: unknown, headers: Record<string, string> = {}): RouteOut {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(value),
    headers,
  };
}

function render(out: RouteOut, rate?: RateInfo): Response {
  const headers: Record<string, string> = {
    'content-type': out.contentType,
    'cache-control': 'no-store',
    ...out.headers,
  };
  if (rate) {
    headers['ratelimit-limit'] = String(rate.limit);
    headers['ratelimit-remaining'] = String(rate.remaining);
    headers['ratelimit-reset'] = String(rate.reset);
  }
  return new Response(out.body, { status: out.status, headers });
}

// ---------------------------------------------------------------------------
// Auth (RFC 6750 §3)
// ---------------------------------------------------------------------------

function bearerToken(request: Request): string | null {
  const auth = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return match ? match[1] : null;
}

function getAccount(token: string): Account | null {
  return db.query('SELECT id, api_key, name, currency FROM accounts WHERE api_key = ?').get(
    token,
  ) as Account | null;
}

function unauthorized(instance: string): RouteOut {
  return problem(
    401,
    `${ERROR_BASE}not-authenticated`,
    'Unauthorized',
    'Missing or invalid bearer token',
    instance,
    {
      'WWW-Authenticate':
        'Bearer realm="meterbase", error="invalid_token", error_description="Missing or invalid bearer token"',
    },
  );
}

// ---------------------------------------------------------------------------
// Rate limiting (IETF RateLimit-* headers)
// ---------------------------------------------------------------------------

/**
 * Token bucket per API key over epoch-aligned 60-second windows.
 * RateLimit-Reset counts seconds until the window resets (delta-seconds, per
 * the IETF draft), not an absolute timestamp.
 */
function rateLimitCheck(apiKey: string): RateInfo {
  const nowSec = nowSeconds();
  const windowStart = Math.floor(nowSec / 60) * 60;

  const row = db
    .query('SELECT count FROM rate_limit_counters WHERE api_key = ? AND window_start = ?')
    .get(apiKey, windowStart) as { count: number } | null;

  let count: number;
  if (row) {
    count = row.count + 1;
    db.query('UPDATE rate_limit_counters SET count = ? WHERE api_key = ? AND window_start = ?').run(
      count,
      apiKey,
      windowStart,
    );
  } else {
    count = 1;
    db.query(
      'INSERT INTO rate_limit_counters (api_key, window_start, count) VALUES (?, ?, 1)',
    ).run(apiKey, windowStart);
  }

  return {
    limit: RATE_LIMIT_PER_MINUTE,
    remaining: Math.max(0, RATE_LIMIT_PER_MINUTE - count),
    reset: Math.max(0, windowStart + 60 - nowSec),
    exceeded: count > RATE_LIMIT_PER_MINUTE,
  };
}

// ---------------------------------------------------------------------------
// Idempotency helpers
// ---------------------------------------------------------------------------

function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function eventId(): string {
  return `evt_${randomUUID().replace(/-/g, '')}`;
}

function invoiceId(): string {
  return `inv_${randomUUID().replace(/-/g, '')}`;
}

// ---------------------------------------------------------------------------
// POST /v1/events
// ---------------------------------------------------------------------------

interface ValidatedEvent {
  meter: string;
  customer: string;
  quantity: number;
  timestamp: number;
}

function parseEventBody(rawBody: string, instance: string): ValidatedEvent | RouteOut {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return problem(400, `${ERROR_BASE}invalid-json`, 'Invalid JSON',
      'Request body must be a JSON object.', instance);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return problem(400, `${ERROR_BASE}invalid-json`, 'Invalid JSON',
      'Request body must be a JSON object.', instance);
  }
  const record = body as Record<string, unknown>;
  const meter = record.meter;
  const customer = record.customer;
  const quantity = record.quantity;
  const timestamp = record.timestamp;
  if (typeof meter !== 'string' || meter === '') {
    return problem(400, `${ERROR_BASE}invalid-parameter`, 'Invalid parameter',
      '"meter" must be a non-empty string.', instance);
  }
  if (typeof customer !== 'string' || customer === '') {
    return problem(400, `${ERROR_BASE}invalid-parameter`, 'Invalid parameter',
      '"customer" must be a non-empty string.', instance);
  }
  if (!Number.isInteger(quantity) || quantity < 0) {
    return problem(400, `${ERROR_BASE}invalid-parameter`, 'Invalid parameter',
      '"quantity" must be a non-negative integer.', instance);
  }
  const ts = timestamp === undefined ? nowSeconds() : timestamp;
  if (!Number.isInteger(ts) || ts < 0) {
    return problem(400, `${ERROR_BASE}invalid-parameter`, 'Invalid parameter',
      '"timestamp" must be a non-negative integer (Unix seconds).', instance);
  }
  return { meter, customer, quantity, timestamp: ts };
}

async function handleEvents(request: Request, account: Account, instance: string): Promise<RouteOut> {
  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey) {
    return problem(400, `${ERROR_BASE}idempotency-key-required`, 'Idempotency-Key required',
      'The Idempotency-Key header is required for POST /v1/events.', instance);
  }

  const rawBody = await request.text();
  const requestHash = sha256Hex(rawBody);

  const existing = db.query(
    `SELECT status, response_body, response_headers, request_hash
     FROM idempotency_keys
     WHERE account = ? AND endpoint = ? AND key = ?`,
  ).get(account.id, EVENTS_ENDPOINT, idempotencyKey) as
    | { status: number; response_body: string; response_headers: string; request_hash: string }
    | null;

  if (existing) {
    if (existing.request_hash === requestHash) {
      const headers: Record<string, string> = existing.response_headers
        ? (JSON.parse(existing.response_headers) as Record<string, string>)
        : {};
      return {
        status: existing.status,
        contentType: 'application/json; charset=utf-8',
        body: existing.response_body,
        headers: { 'idempotent-replayed': 'true', ...headers },
      };
    }
    return problem(409, `${ERROR_BASE}idempotency-conflict`, 'Idempotency key conflict',
      `The Idempotency-Key "${idempotencyKey}" was already used with a different request body.`,
      instance);
  }

  const parsed = parseEventBody(rawBody, instance);
  if ('status' in parsed) return parsed;
  const { meter, customer, quantity, timestamp } = parsed;

  const meterRow = db.query(
    'SELECT id, currency, mode FROM meters WHERE account = ? AND id = ?',
  ).get(account.id, meter) as { id: string; currency: string; mode: string } | null;
  if (!meterRow) {
    return problem(400, `${ERROR_BASE}unknown-meter`, 'Unknown meter',
      `Meter "${meter}" does not exist on this account.`, instance);
  }
  const customerRow = db.query(
    'SELECT id FROM customers WHERE id = ? AND account = ?',
  ).get(customer, account.id) as { id: string } | null;
  if (!customerRow) {
    return problem(400, `${ERROR_BASE}unknown-customer`, 'Unknown customer',
      `Customer "${customer}" does not exist on this account.`, instance);
  }

  const id = eventId();
  const createdAt = nowSeconds();
  const responseBody = JSON.stringify({
    object: 'event',
    id,
    meter,
    customer,
    quantity,
    timestamp,
  });

  const write = db.transaction(() => {
    db.query(
      `INSERT INTO events (id, account, meter, customer, quantity, timestamp, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, account.id, meter, customer, quantity, timestamp, idempotencyKey, createdAt);
    db.query(
      `INSERT INTO idempotency_keys
       (account, endpoint, key, request_hash, status, response_body, response_headers, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      account.id,
      EVENTS_ENDPOINT,
      idempotencyKey,
      requestHash,
      201,
      responseBody,
      JSON.stringify({ 'content-type': 'application/json; charset=utf-8' }),
      createdAt,
    );
  });
  write();

  return jsonBody(201, {
    object: 'event',
    id,
    meter,
    customer,
    quantity,
    timestamp,
  });
}

// ---------------------------------------------------------------------------
// GET /v1/usage
// ---------------------------------------------------------------------------

function optionalUnixSeconds(value: string | null, name: string): { sec: number } | { problem: RouteOut } {
  if (value === null) return { sec: 0 };
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value.trim()) {
    return {
      problem: problem(400, `${ERROR_BASE}invalid-parameter`, 'Invalid parameter',
        `Query parameter "${name}" must be a non-negative integer (Unix seconds).`,
        ''),
    };
  }
  return { sec: parsed };
}

function handleUsage(url: URL, account: Account, instance: string): RouteOut {
  const meter = url.searchParams.get('meter');
  const customer = url.searchParams.get('customer');
  if (!meter || !customer) {
    return problem(400, `${ERROR_BASE}invalid-parameter`, 'Invalid parameter',
      'Query parameters "meter" and "customer" are required.', instance);
  }
  const from = optionalUnixSeconds(url.searchParams.get('from'), 'from');
  if ('problem' in from) return from.problem;
  const to = optionalUnixSeconds(url.searchParams.get('to'), 'to');
  if ('problem' in to) return to.problem;

  const meterRow = db.query(
    'SELECT mode, tiers FROM meters WHERE account = ? AND id = ?',
  ).get(account.id, meter) as { mode: string; tiers: string } | null;
  if (!meterRow) {
    return problem(400, `${ERROR_BASE}unknown-meter`, 'Unknown meter',
      `Meter "${meter}" does not exist on this account.`, instance);
  }

  const row = db.query(
    `SELECT COALESCE(SUM(quantity), 0) AS quantity
     FROM events
     WHERE account = ? AND meter = ? AND customer = ?
       AND (? = 0 OR timestamp >= ?)
       AND (? = 0 OR timestamp <= ?)`,
  ).get(account.id, meter, customer, from.sec, from.sec, to.sec, to.sec) as
    | { quantity: number }
    | null;
  const quantity = Number(row?.quantity ?? 0);

  const tiers: Tier[] = JSON.parse(meterRow.tiers);
  const pricing = priceMeter(meterRow.mode as 'graduated' | 'volume', tiers, quantity);

  return jsonBody(200, {
    object: 'usage',
    meter,
    customer,
    from: from.sec || null,
    to: to.sec || null,
    quantity,
    amount: pricing.totalAmount,
    pricing_mode: meterRow.mode,
    tiers: pricing.tiers,
  });
}

// ---------------------------------------------------------------------------
// POST /v1/invoices
// ---------------------------------------------------------------------------

function buildInvoiceBody(invoiceId: string): RouteOut | null {
  const inv = db.query(
    `SELECT id, account, customer, currency, period_start, period_end, status, subtotal, total
     FROM invoices WHERE id = ?`,
  ).get(invoiceId) as
    | { id: string; customer: string; currency: string; period_start: number; period_end: number; status: string; subtotal: number; total: number }
    | null;
  if (!inv) return null;
  const lines = db.query(
    `SELECT meter, quantity, amount, pricing_mode, tier_breakdown
     FROM invoice_line_items WHERE invoice = ? ORDER BY ordinal`,
  ).all(invoiceId) as Array<{
    meter: string; quantity: number; amount: number; pricing_mode: string; tier_breakdown: string;
  }>;
  return jsonBody(201, {
    object: 'invoice',
    id: inv.id,
    customer: inv.customer,
    currency: inv.currency,
    period_start: inv.period_start,
    period_end: inv.period_end,
    status: inv.status,
    subtotal: inv.subtotal,
    total: inv.total,
    line_items: lines.map((line) => ({
      meter: line.meter,
      quantity: line.quantity,
      amount: line.amount,
      pricing_mode: line.pricing_mode,
      tiers: JSON.parse(line.tier_breakdown),
    })),
  });
}

async function handleCreateInvoice(request: Request, account: Account, instance: string): Promise<RouteOut> {
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return problem(400, `${ERROR_BASE}invalid-json`, 'Invalid JSON',
      'Request body must be a JSON object.', instance);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return problem(400, `${ERROR_BASE}invalid-json`, 'Invalid JSON',
      'Request body must be a JSON object.', instance);
  }
  const record = body as Record<string, unknown>;
  const customer = record.customer;
  const periodStart = record.period_start;
  const periodEnd = record.period_end;
  if (typeof customer !== 'string' || customer === '') {
    return problem(400, `${ERROR_BASE}invalid-parameter`, 'Invalid parameter',
      '"customer" must be a non-empty string.', instance);
  }
  if (!Number.isInteger(periodStart) || periodStart < 0) {
    return problem(400, `${ERROR_BASE}invalid-parameter`, 'Invalid parameter',
      '"period_start" must be a non-negative integer (Unix seconds).', instance);
  }
  if (!Number.isInteger(periodEnd) || periodEnd < 0) {
    return problem(400, `${ERROR_BASE}invalid-parameter`, 'Invalid parameter',
      '"period_end" must be a non-negative integer (Unix seconds).', instance);
  }
  if (periodEnd <= periodStart) {
    return problem(400, `${ERROR_BASE}invalid-parameter`, 'Invalid parameter',
      '"period_end" must be greater than "period_start".', instance);
  }
  const customerRow = db.query(
    'SELECT id FROM customers WHERE id = ? AND account = ?',
  ).get(customer, account.id) as { id: string } | null;
  if (!customerRow) {
    return problem(400, `${ERROR_BASE}unknown-customer`, 'Unknown customer',
      `Customer "${customer}" does not exist on this account.`, instance);
  }

  // Idempotent per (customer, period_start, period_end): return the existing invoice.
  const existing = db.query(
    `SELECT id FROM invoices
     WHERE account = ? AND customer = ? AND period_start = ? AND period_end = ?`,
  ).get(account.id, customer, periodStart, periodEnd) as { id: string } | null;
  if (existing) {
    const out = buildInvoiceBody(existing.id);
    return out ?? jsonBody(201, { object: 'invoice', id: existing.id });
  }

  const meters = db.query(
    `SELECT id, currency, mode, tiers FROM meters WHERE account = ? ORDER BY id`,
  ).all(account.id) as Array<{
    id: string; currency: string; mode: string; tiers: string;
  }>;

  let subtotal = 0;
  let total = 0;
  const lines: Array<{
    ordinal: number; meter: string; quantity: number; amount: number; currency: string;
    pricing_mode: string; tier_breakdown: string;
  }> = [];
  let ordinal = 0;
  for (const meter of meters) {
    const row = db.query(
      `SELECT COALESCE(SUM(quantity), 0) AS quantity
       FROM events
       WHERE account = ? AND customer = ? AND meter = ?
         AND timestamp >= ? AND timestamp < ?`,
    ).get(account.id, customer, meter.id, periodStart, periodEnd) as { quantity: number };
    const quantity = Number(row.quantity ?? 0);
    if (quantity <= 0) continue;
    const tiers: Tier[] = JSON.parse(meter.tiers);
    const pricing = priceMeter(meter.mode as 'graduated' | 'volume', tiers, quantity);
    const amount = pricing.totalAmount;
    lines.push({
      ordinal: ordinal++,
      meter: meter.id,
      quantity,
      amount,
      currency: meter.currency,
      pricing_mode: meter.mode,
      tier_breakdown: JSON.stringify(pricing.tiers),
    });
    total += amount;
  }
  subtotal = total;

  const id = invoiceId();
  const createdAt = nowSeconds();
  try {
    const write = db.transaction(() => {
      db.query(
        `INSERT INTO invoices
         (id, account, customer, currency, period_start, period_end, status, subtotal, total, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      ).run(id, account.id, customer, account.currency, periodStart, periodEnd, subtotal, total, createdAt);
      for (const line of lines) {
        db.query(
          `INSERT INTO invoice_line_items
           (id, invoice, ordinal, meter, quantity, amount, currency, pricing_mode, tier_breakdown)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `li_${randomUUID().replace(/-/g, '')}`,
          id,
          line.ordinal,
          line.meter,
          line.quantity,
          line.amount,
          line.currency,
          line.pricing_mode,
          line.tier_breakdown,
        );
      }
    });
    write();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNIQUE')) {
      // Concurrent creation race: fall through to the existing invoice.
      const out = buildInvoiceBody(
        (db.query(`SELECT id FROM invoices WHERE account = ? AND customer = ? AND period_start = ? AND period_end = ?`)
          .get(account.id, customer, periodStart, periodEnd) as { id: string } | null)?.id ?? '',
      );
      if (out) return out;
    }
    throw error;
  }

  return buildInvoiceBody(id) ?? jsonBody(201, { object: 'invoice', id });
}

// ---------------------------------------------------------------------------
// GET /v1/invoices (cursor pagination)
// ---------------------------------------------------------------------------

function encodeCursor(createdAt: number, id: string): string {
  return Buffer.from(`${createdAt}:${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: number; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const [createdAtStr, id] = decoded.split(':');
    const createdAt = Number.parseInt(createdAtStr ?? '', 10);
    if (!id || !Number.isInteger(createdAt)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function handleListInvoices(url: URL, account: Account, instance: string): RouteOut {
  const limitRaw = url.searchParams.get('limit');
  let limit = 10;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1) {
      return problem(400, `${ERROR_BASE}invalid-limit`, 'Invalid limit',
        '"limit" must be an integer between 1 and 100.', instance);
    }
    limit = Math.min(100, n);
  }

  const cursorRaw = url.searchParams.get('starting_after');
  let after: { createdAt: number; id: string } | null = null;
  if (cursorRaw !== null) {
    after = decodeCursor(cursorRaw);
    if (!after) {
      return problem(400, `${ERROR_BASE}invalid-cursor`, 'Invalid cursor',
        '"starting_after" is not a valid pagination cursor.', instance);
    }
  }

  const params: Array<string | number> = [account.id];
  let where = 'WHERE account = ?';
  if (after) {
    where += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
    params.push(after.createdAt, after.createdAt, after.id);
  }

  const rows = db.query(
    `SELECT id, customer, currency, period_start, period_end, status, subtotal, total, created_at
     FROM invoices ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  ).all(...params, limit + 1) as Array<{
    id: string; customer: string; currency: string; period_start: number; period_end: number;
    status: string; subtotal: number; total: number; created_at: number;
  }>;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  let data: Array<Record<string, unknown>> = [];
  if (page.length) {
    const placeholders = page.map(() => '?').join(',');
    const lineItems = db.query(
      `SELECT invoice, meter, quantity, amount, pricing_mode, tier_breakdown
       FROM invoice_line_items
       WHERE invoice IN (${placeholders})
       ORDER BY invoice, ordinal`,
    ).all(...page.map((row) => row.id)) as Array<{
      invoice: string; meter: string; quantity: number; amount: number;
      pricing_mode: string; tier_breakdown: string;
    }>;
    const itemsByInvoice = new Map<string, Array<Record<string, unknown>>>();
    for (const item of lineItems) {
      const list = itemsByInvoice.get(item.invoice) ?? [];
      list.push({
        meter: item.meter,
        quantity: item.quantity,
        amount: item.amount,
        pricing_mode: item.pricing_mode,
        tiers: JSON.parse(item.tier_breakdown),
      });
      itemsByInvoice.set(item.invoice, list);
    }
    data = page.map((row) => ({
      object: 'invoice',
      id: row.id,
      customer: row.customer,
      currency: row.currency,
      period_start: row.period_start,
      period_end: row.period_end,
      status: row.status,
      subtotal: row.subtotal,
      total: row.total,
      line_items: itemsByInvoice.get(row.id) ?? [],
    }));
  }

  const last = page[page.length - 1]!;
  const nextCursor = hasMore ? encodeCursor(last.created_at, last.id) : null;
  return jsonBody(200, { object: 'list', data, has_more: hasMore, next_cursor: nextCursor });
}

// ---------------------------------------------------------------------------
// Webhooks (Stripe-compatible signatures)
// ---------------------------------------------------------------------------

function hmacSha256Hex(key: string, message: string): string {
  return createHmac('sha256', key).update(message).digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function handleWebhookSign(request: Request, instance: string): Promise<RouteOut> {
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return problem(400, `${ERROR_BASE}invalid-json`, 'Invalid JSON',
      'Request body must be a JSON object.', instance);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof (body as Record<string, unknown>).payload !== 'string') {
    return problem(400, `${ERROR_BASE}invalid-parameter`, 'Invalid parameter',
      '"payload" must be a string.', instance);
  }
  const payload = (body as Record<string, string>).payload;
  const timestamp = nowSeconds();
  const signature = hmacSha256Hex(WEBHOOK_SECRET, `${timestamp}.${payload}`);
  const header = `t=${timestamp},v1=${signature}`;
  return jsonBody(200, { header });
}

async function handleWebhookVerify(request: Request, instance: string): Promise<RouteOut> {
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return problem(400, `${ERROR_BASE}invalid-json`, 'Invalid JSON',
      'Request body must be a JSON object.', instance);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return problem(400, `${ERROR_BASE}invalid-json`, 'Invalid JSON',
      'Request body must be a JSON object.', instance);
  }
  const record = body as Record<string, unknown>;
  const payload = record.payload;
  const signatureHeader = record.signature_header;
  if (typeof payload !== 'string') {
    return problem(400, `${ERROR_BASE}invalid-parameter`, 'Invalid parameter',
      '"payload" must be a string.', instance, {}, { valid: false, reason: 'payload must be a string' });
  }
  if (typeof signatureHeader !== 'string') {
    return problem(400, `${ERROR_BASE}invalid-parameter`, 'Invalid parameter',
      '"signature_header" must be a string.', instance, {}, { valid: false, reason: 'signature_header must be a string' });
  }

  const timestamps: number[] = [];
  const signatures: string[] = [];
  for (const part of signatureHeader.split(',').map((s) => s.trim()).filter(Boolean)) {
    const t = /^t=(\d+)$/.exec(part);
    if (t) {
      timestamps.push(Number.parseInt(t[1], 10));
      continue;
    }
    const v = /^v([0-9]+)=([0-9a-fA-F]+)$/.exec(part);
    if (v) signatures.push(v[2].toLowerCase());
  }

  const nowSec = nowSeconds();
  let valid = false;
  let matchedTimestamp: number | null = null;
  for (const timestamp of timestamps) {
    const expected = hmacSha256Hex(WEBHOOK_SECRET, `${timestamp}.${payload}`).toLowerCase();
    for (const signature of signatures) {
      if (constantTimeEqual(expected, signature)) {
        valid = true;
        matchedTimestamp = timestamp;
        break;
      }
    }
    if (valid) break;
  }

  let reason: string | null = null;
  if (!valid) {
    reason = signatures.length === 0 ? 'no_signature_found' : 'signature_did_not_match';
  } else if (matchedTimestamp !== null && Math.abs(nowSec - matchedTimestamp) > WEBHOOK_TOLERANCE_SECONDS) {
    valid = false;
    reason = 'timestamp_outside_tolerance';
  }

  if (valid) return jsonBody(200, { valid: true });
  return problem(400, `${ERROR_BASE}webhook-invalid`, 'Invalid webhook signature',
    reason ?? 'invalid signature', instance, {}, { valid: false, reason: reason ?? 'invalid signature' });
}

// ---------------------------------------------------------------------------
// GET /dashboard (public, server-rendered HTML)
// ---------------------------------------------------------------------------

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function dashboardPage(account: Account, invoices: unknown[], usage: Array<{ meter: string; quantity: number; amount: number }>): string {
  const rows = invoices.map((inv: any) => `
    <tr>
      <td>${escapeHtml(inv.id)}</td>
      <td>${formatMinorUnits(inv.currency, inv.total)}</td>
      <td>${new Date(inv.period_start * 1000).toISOString().slice(0, 10)} – ${new Date(inv.period_end * 1000).toISOString().slice(0, 10)}</td>
      <td>${escapeHtml(inv.status)}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="muted">No invoices yet.</td></tr>';

  const usageRows = usage.map((u) => `
    <tr>
      <td>${escapeHtml(u.meter)}</td>
      <td>${u.quantity}</td>
      <td>${formatMinorUnits(account.currency, u.amount)}</td>
    </tr>`).join('') || '<tr><td colspan="3" class="muted">No usage in the current period.</td></tr>';

  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meterbase — ${escapeHtml(account.id)}</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 2rem; line-height: 1.6; color: #1f2937; }
  h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
  h2 { font-size: 1.125rem; margin: 1.5rem 0 0.5rem; }
  .account-badge { display: inline-block; font-size: 0.875rem; background: #eef2ff; color: #3730a3; padding: 0.125rem 0.5rem; border-radius: 0.25rem; margin-left: 0.5rem; }
  table { border-collapse: collapse; width: 100%; max-width: 720px; margin-top: 0.5rem; }
  th, td { border: 1px solid #e5e7eb; padding: 0.5rem 0.75rem; text-align: left; font-size: 0.9375rem; }
  th { background: #f3f4f6; font-weight: 600; white-space: nowrap; }
  td.number { text-align: right; white-space: nowrap; }
  .muted { color: #6b7280; }
  .note { margin-top: 1rem; color: #6b7280; font-size: 0.875rem; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<h1>Meterbase <span class="account-badge">Account: ${escapeHtml(account.id)}</span></h1>
<p><strong>${escapeHtml(account.name)}</strong> — currency ${escapeHtml(account.currency)}.</p>

<h2>Invoices</h2>
<table>
<thead><tr><th>Id</th><th>Total</th><th>Period</th><th>Status</th></tr></thead>
<tbody>${rows}</tbody>
</table>

<h2>Current-period usage (${periodStart.toISOString().slice(0, 10)} – ${periodEnd.toISOString().slice(0, 10)})</h2>
<table>
<thead><tr><th>Meter</th><th>Quantity</th><th>Amount</th></tr></thead>
<tbody>${usageRows}</tbody>
</table>

<p class="note">Server-rendered by Meterbase. Works with JavaScript disabled.</p>
</body>
</html>`;
}

function handleDashboard(url: URL): RouteOut | Response {
  const accountId = url.searchParams.get('account');
  if (!accountId) {
    return problem(400, `${ERROR_BASE}invalid-parameter`, 'Invalid parameter',
      'Query parameter "account" is required.', url.pathname);
  }
  const account = db.query('SELECT id, api_key, name, currency FROM accounts WHERE id = ?').get(
    accountId,
  ) as Account | null;
  if (!account) {
    return problem(404, `${ERROR_BASE}unknown-account`, 'Unknown account',
      `Account "${accountId}" does not exist.`, url.pathname);
  }

  const invoices = db.query(
    `SELECT id, customer, currency, period_start, period_end, status, subtotal, total
     FROM invoices WHERE account = ? ORDER BY created_at DESC`,
  ).all(accountId);

  const nowSec = nowSeconds();
  const periodStart = Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) / 1000);
  const periodEnd = Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1) / 1000);
  const meters = db.query('SELECT id, mode, tiers FROM meters WHERE account = ?').all(accountId) as Array<{
    id: string; mode: string; tiers: string;
  }>;
  const usage = meters.map((meter) => {
    const row = db.query(
      `SELECT COALESCE(SUM(quantity), 0) AS quantity
       FROM events WHERE account = ? AND meter = ? AND timestamp >= ? AND timestamp < ?`,
    ).get(accountId, meter.id, periodStart, periodEnd) as { quantity: number };
    const quantity = Number(row.quantity ?? 0);
    const tiers: Tier[] = JSON.parse(meter.tiers);
    const pricing = priceMeter(meter.mode as 'graduated' | 'volume', tiers, quantity);
    return { meter: meter.id, quantity, amount: pricing.totalAmount };
  });

  return {
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: dashboardPage(account, invoices, usage),
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (pathname === '/__ready__') {
      return new Response(null, { status: 204 });
    }
    if (pathname === '/dashboard') {
      const out = handleDashboard(url);
      return out instanceof Response ? out : render(out);
    }
    if (!pathname.startsWith('/v1/')) {
      return render(problem(404, `${ERROR_BASE}not-found`, 'Not found',
        `No route for ${method} ${pathname}`, pathname));
    }

    // Auth + rate limiting apply to everything under /v1/.
    const token = bearerToken(request);
    let rate: RateInfo | null = null;
    if (token !== null) {
      rate = rateLimitCheck(token);
      if (rate.exceeded) {
        return render(
          problem(429, `${ERROR_BASE}rate-limited`, 'Too Many Requests',
            'Request rate limit exceeded. Try again later.', pathname, {
              'retry-after': String(rate.reset),
            }),
          rate,
        );
      }
    }

    const account = token !== null ? getAccount(token) : null;
    if (!account) return render(unauthorized(pathname), rate);

    let out: RouteOut;
    try {
      if (method === 'POST' && pathname === '/v1/events') {
        out = await handleEvents(request, account, pathname);
      } else if (method === 'GET' && pathname === '/v1/usage') {
        out = handleUsage(url, account, pathname);
      } else if (method === 'POST' && pathname === '/v1/invoices') {
        out = await handleCreateInvoice(request, account, pathname);
      } else if (method === 'GET' && pathname === '/v1/invoices') {
        out = handleListInvoices(url, account, pathname);
      } else if (method === 'POST' && pathname === '/v1/webhooks/sign') {
        out = await handleWebhookSign(request, pathname);
      } else if (method === 'POST' && pathname === '/v1/webhooks/verify') {
        out = await handleWebhookVerify(request, pathname);
      } else {
        out = problem(404, `${ERROR_BASE}not-found`, 'Not found',
          `No route for ${method} ${pathname}`, pathname);
      }
    } catch (error) {
      out = problem(500, `${ERROR_BASE}server-error`, 'Internal server error',
        error instanceof Error ? error.message : String(error), pathname);
    }
    return render(out, rate);
  },
});

console.log(
  `meterbase: serving on http://${server.hostname}:${server.port} (DATA_DIR=${DATA_DIR})`,
);

export default server;
