/**
 * Meterbase — fixture seed (real, not a stub).
 *
 * `bun run seed` deletes and recreates `$DATA_DIR/meterbase.db` with the schema in
 * docs/SCHEMA.md and the exact fixtures from the "## Fixtures" section of TASK.md.
 * It is idempotent: run it as often as you like, the result is the same set of rows.
 *
 * If you change the schema, change it here and update docs/SCHEMA.md in the same
 * step — the schema is the contract the endpoints are written against.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SCHEMA_VERSION = 1;
export const DATA_DIR = resolve(process.env.DATA_DIR ?? './.data');
export const DB_PATH = join(DATA_DIR, 'meterbase.db');

/**
 * Canonical schema. Conventions:
 *   - every `timestamp` / `created_at` / `period_*` column is Unix **seconds**
 *   - every money column is an integer in **minor units** of its ISO 4217 currency
 *   - JSON columns are TEXT containing JSON (`tiers`, `tier_breakdown`, ...)
 */
export const SCHEMA_SQL = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE accounts (
  id         TEXT PRIMARY KEY,
  api_key    TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  currency   TEXT NOT NULL CHECK (length(currency) = 3),
  created_at INTEGER NOT NULL
);

CREATE TABLE customers (
  id         TEXT PRIMARY KEY,
  account    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_customers_account ON customers(account);

CREATE TABLE meters (
  id         TEXT NOT NULL,
  account    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  currency   TEXT NOT NULL CHECK (length(currency) = 3),
  mode       TEXT NOT NULL CHECK (mode IN ('graduated', 'volume')),
  tiers      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account, id)
);

CREATE TABLE events (
  id              TEXT PRIMARY KEY,
  account         TEXT NOT NULL,
  meter           TEXT NOT NULL,
  customer        TEXT NOT NULL,
  quantity        INTEGER NOT NULL,
  timestamp       INTEGER NOT NULL,
  idempotency_key TEXT,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (account, meter) REFERENCES meters(account, id),
  FOREIGN KEY (customer) REFERENCES customers(id)
);

CREATE INDEX idx_events_billing ON events(account, customer, meter, timestamp);
CREATE INDEX idx_events_account_ts ON events(account, timestamp);
CREATE UNIQUE INDEX idx_events_idempotency
  ON events(account, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE idempotency_keys (
  account          TEXT NOT NULL,
  endpoint         TEXT NOT NULL,
  key              TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  status           INTEGER NOT NULL,
  response_body    TEXT NOT NULL,
  response_headers TEXT NOT NULL DEFAULT '{}',
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (account, endpoint, key)
);

CREATE TABLE invoices (
  id           TEXT PRIMARY KEY,
  account      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  customer     TEXT NOT NULL REFERENCES customers(id),
  currency     TEXT NOT NULL CHECK (length(currency) = 3),
  period_start INTEGER NOT NULL,
  period_end   INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',
  subtotal     INTEGER NOT NULL,
  total        INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (account, customer, period_start, period_end)
);

CREATE INDEX idx_invoices_list ON invoices(account, created_at DESC, id DESC);
CREATE INDEX idx_invoices_customer ON invoices(account, customer, created_at DESC);

CREATE TABLE invoice_line_items (
  id             TEXT PRIMARY KEY,
  invoice        TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  ordinal        INTEGER NOT NULL,
  meter          TEXT NOT NULL,
  quantity       INTEGER NOT NULL,
  amount         INTEGER NOT NULL,
  currency       TEXT NOT NULL CHECK (length(currency) = 3),
  pricing_mode   TEXT NOT NULL CHECK (pricing_mode IN ('graduated', 'volume')),
  tier_breakdown TEXT NOT NULL,
  UNIQUE (invoice, ordinal)
);

CREATE INDEX idx_line_items_invoice ON invoice_line_items(invoice, ordinal);

CREATE TABLE rate_limit_counters (
  api_key      TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (api_key, window_start)
);
`;

export interface Tier {
  up_to: number | null;
  unit_amount: number;
}

const tier = (up_to: number | null, unit_amount: number): Tier => ({ up_to, unit_amount });

/** TASK.md "## Fixtures" — keep these rows exactly as written there. */
const ACCOUNTS: Array<{ id: string; api_key: string; name: string; currency: string }> = [
  { id: 'acct_demo', api_key: 'mb_test_demo_key', name: 'Demo account (USD)', currency: 'USD' },
  { id: 'acct_jpy', api_key: 'mb_test_jpy_key', name: 'Demo account (JPY)', currency: 'JPY' },
];

const METERS: Array<{ id: string; account: string; currency: string; mode: 'graduated' | 'volume'; tiers: Tier[] }> = [
  {
    id: 'api_calls',
    account: 'acct_demo',
    currency: 'USD',
    mode: 'graduated',
    tiers: [tier(1000, 5), tier(null, 2)],
  },
  {
    id: 'storage_gb',
    account: 'acct_demo',
    currency: 'USD',
    mode: 'volume',
    tiers: [tier(100, 10), tier(null, 3)],
  },
  {
    id: 'api_calls',
    account: 'acct_jpy',
    currency: 'JPY',
    mode: 'graduated',
    tiers: [tier(1000, 5), tier(null, 2)],
  },
];

const CUSTOMERS: Array<{ id: string; account: string; name: string }> = [
  { id: 'cus_alpha', account: 'acct_demo', name: 'Alpha Co' },
  { id: 'cus_beta', account: 'acct_demo', name: 'Beta Co' },
  { id: 'cus_yen', account: 'acct_jpy', name: 'Yen Co' },
];

interface Counts {
  accounts: number;
  meters: number;
  customers: number;
  events: number;
  invoices: number;
}

function resetDatabase(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
}

function countRows(db: Database, table: string): number {
  const row = db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | null;
  return row?.n ?? 0;
}

function seedRows(db: Database, now: number): void {
  const insertAccount = db.query(
    'INSERT INTO accounts (id, api_key, name, currency, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const insertCustomer = db.query(
    'INSERT INTO customers (id, account, name, created_at) VALUES (?, ?, ?, ?)',
  );
  const insertMeter = db.query(
    'INSERT INTO meters (id, account, currency, mode, tiers, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertMeta = db.query('INSERT INTO meta (key, value) VALUES (?, ?)');

  const writeAll = db.transaction(() => {
    for (const account of ACCOUNTS) {
      insertAccount.run(account.id, account.api_key, account.name, account.currency, now);
    }
    for (const customer of CUSTOMERS) {
      insertCustomer.run(customer.id, customer.account, customer.name, now);
    }
    for (const meter of METERS) {
      insertMeter.run(
        meter.id,
        meter.account,
        meter.currency,
        meter.mode,
        JSON.stringify(meter.tiers),
        now,
      );
    }
    insertMeta.run('schema_version', String(SCHEMA_VERSION));
    insertMeta.run('seed_version', 'meterbase-fixtures-v1');
    insertMeta.run('seeded_at', String(now));
  });

  writeAll();
}

export function seed(): { path: string; counts: Counts } {
  mkdirSync(DATA_DIR, { recursive: true });
  resetDatabase(DB_PATH);

  const now = Math.floor(Date.now() / 1000);
  const db = new Database(DB_PATH, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_SQL);
  seedRows(db, now);

  const counts: Counts = {
    accounts: countRows(db, 'accounts'),
    meters: countRows(db, 'meters'),
    customers: countRows(db, 'customers'),
    events: countRows(db, 'events'),
    invoices: countRows(db, 'invoices'),
  };
  db.close();
  return { path: DB_PATH, counts };
}

function main(): void {
  const { path, counts } = seed();
  console.log(
    `meterbase seed: ${path} (schema v${SCHEMA_VERSION}) -> ` +
      `${counts.accounts} accounts, ${counts.meters} meters, ${counts.customers} customers, ` +
      `${counts.events} events, ${counts.invoices} invoices`,
  );
}

if (import.meta.main) main();
