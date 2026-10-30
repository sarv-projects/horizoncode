# Meterbase data model

`bun run seed` owns the database: it deletes and recreates `$DATA_DIR/meterbase.db`
(default `./.data/meterbase.db`) from `SCHEMA_SQL` in `src/seed.ts`. There are no
migrations and no ORM — use `bun:sqlite` directly, and if you change the schema, change
`src/seed.ts` **and** this file in the same step, then rerun the seed.

```ts
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
const db = new Database(join(process.env.DATA_DIR ?? './.data', 'meterbase.db'));
const account = db.query('SELECT id, currency FROM accounts WHERE api_key = ?').get(token);
```

## Conventions

- **Time**: every `timestamp` / `created_at` / `period_start` / `period_end` column is a
  Unix timestamp in **seconds** (INTEGER), matching the API payloads in `TASK.md`.
- **Money**: every money column is an **integer in minor units** of the row's ISO 4217
  currency. Never floats. The minor-unit exponent is per currency and is *not* always 2:
  USD 2, EUR 2, GBP 2, JPY 0, KRW 0, CLP 0, ISK 0, KWD 3, BHD 3, OMR 3, TND 3. Look the
  exponent up per currency; do not hardcode 2.
- **JSON**: `tiers`, `tier_breakdown` and `response_headers` are TEXT holding JSON.
- **Scoping**: every business row belongs to one account. The bearer token resolves to
  exactly one `accounts.id`; all queries are filtered by that account. Only `GET
  /dashboard` is public, and it still needs `?account=<id>`.
- Integers are `number` in JS; `bun:sqlite` returns SQLite INTEGER as `number` unless the
  value exceeds 2^53.

## API shapes the schema must serve

`TASK.md` section "### Response shapes (exact field names)" pins these; the schema is
designed to emit them without extra tables:

| API field | source |
| --- | --- |
| `GET /v1/usage` → `quantity`, `amount`, `pricing_mode`, `tiers[]` | computed from `events` + `meters` (no table) |
| invoice `subtotal`, `total` | `invoices.subtotal`, `invoices.total` (equal; no tax in scope) |
| invoice `line_items[]` | `invoice_line_items` rows ordered by `ordinal` |
| line item `quantity`, `amount`, `pricing_mode`, `tiers[]` | `quantity`, `amount`, `pricing_mode`, `tier_breakdown` |
| list `object`, `data`, `has_more`, `next_cursor` | pagination over `invoices` |

## `meta`

| column | type | notes |
| --- | --- | --- |
| `key` | TEXT PK | |
| `value` | TEXT NOT NULL | |

Rows written by the seed: `schema_version = 1`, `seed_version = meterbase-fixtures-v1`,
`seeded_at = <unix seconds>`.

## `accounts`

| column | type | notes |
| --- | --- | --- |
| `id` | TEXT PK | `acct_demo`, `acct_jpy` |
| `api_key` | TEXT NOT NULL UNIQUE | bearer token, e.g. `mb_test_demo_key` |
| `name` | TEXT NOT NULL | display name |
| `currency` | TEXT NOT NULL | ISO 4217 alpha-3, e.g. `USD` |
| `created_at` | INTEGER NOT NULL | Unix seconds |

The token lookup is `SELECT id, currency FROM accounts WHERE api_key = ?`; no token or no
row means 401 (RFC 6750 §3 challenge, see `TASK.md`).

## `customers`

| column | type | notes |
| --- | --- | --- |
| `id` | TEXT PK | `cus_alpha`, `cus_beta`, `cus_yen` |
| `account` | TEXT NOT NULL → `accounts.id` | |
| `name` | TEXT NOT NULL | convenience only; not required by the API |
| `created_at` | INTEGER NOT NULL | |

Index: `idx_customers_account(account)`.

## `meters`

| column | type | notes |
| --- | --- | --- |
| `id` | TEXT NOT NULL | `api_calls`, `storage_gb` |
| `account` | TEXT NOT NULL → `accounts.id` | |
| `currency` | TEXT NOT NULL | must match the account currency |
| `mode` | TEXT NOT NULL | `CHECK (mode IN ('graduated','volume'))` |
| `tiers` | TEXT NOT NULL | JSON array, see below |
| `created_at` | INTEGER NOT NULL | |

Primary key is **`(account, id)`**: meter ids are scoped per account, and `api_calls`
exists on both accounts. Tiers example for `api_calls` on `acct_demo`:

```json
[{"up_to": 1000, "unit_amount": 5}, {"up_to": null, "unit_amount": 2}]
```

`up_to` is an inclusive upper bound (`null` = infinity), `unit_amount` is minor units per
unit. `graduated`: each tier prices only the units inside its own range. `volume`: the tier
the total quantity lands in prices **all** units.

## `events`

| column | type | notes |
| --- | --- | --- |
| `id` | TEXT PK | response `id`, `evt_...` |
| `account` | TEXT NOT NULL | resolved from the bearer token |
| `meter` | TEXT NOT NULL | `(account, meter)` → `meters(account, id)` |
| `customer` | TEXT NOT NULL → `customers.id` | |
| `quantity` | INTEGER NOT NULL | signed; validate non-negativity at the edge if you want |
| `timestamp` | INTEGER NOT NULL | Unix seconds; may fall outside any invoice period |
| `idempotency_key` | TEXT NULL | audit trail only |
| `created_at` | INTEGER NOT NULL | ingest time |

Indexes: `idx_events_billing(account, customer, meter, timestamp)` for usage/invoice
aggregation, `idx_events_account_ts(account, timestamp)`, and a partial unique index on
`(account, idempotency_key)` where the key is not null.

The partial unique index is a safety net, **not** the idempotency implementation: the
canonical store is `idempotency_keys`, because it must also hold the original status and
response body.

## `idempotency_keys`

| column | type | notes |
| --- | --- | --- |
| `account` | TEXT NOT NULL | |
| `endpoint` | TEXT NOT NULL | e.g. `POST /v1/events` |
| `key` | TEXT NOT NULL | `Idempotency-Key` header value |
| `request_hash` | TEXT NOT NULL | stable hash of the canonicalized request body |
| `status` | INTEGER NOT NULL | status of the original response |
| `response_body` | TEXT NOT NULL | original body, replayed verbatim |
| `response_headers` | TEXT NOT NULL DEFAULT '{}' | JSON map of headers to replay |
| `created_at` | INTEGER NOT NULL | |

Primary key `(account, endpoint, key)`. Required behaviour (`TASK.md`): same key + same
body → replay the stored status/body and add `Idempotent-Replayed: true`; same key +
different body → `409` problem+json.

## `invoices`

| column | type | notes |
| --- | --- | --- |
| `id` | TEXT PK | `inv_...` |
| `account` | TEXT NOT NULL → `accounts.id` | |
| `customer` | TEXT NOT NULL → `customers.id` | |
| `currency` | TEXT NOT NULL | account currency |
| `period_start` | INTEGER NOT NULL | Unix seconds, inclusive |
| `period_end` | INTEGER NOT NULL | Unix seconds, exclusive |
| `status` | TEXT NOT NULL DEFAULT 'open' | returned as the invoice `status` |
| `subtotal` | INTEGER NOT NULL | minor units, sum of line amounts |
| `total` | INTEGER NOT NULL | minor units; equals `subtotal` (no tax in scope) |
| `created_at` | INTEGER NOT NULL | cursor ordering key |

`UNIQUE (account, customer, period_start, period_end)` backs the "idempotent per
`(customer, period_start, period_end)`" rule — a second identical request returns the
existing invoice instead of inserting a duplicate.

Indexes: `idx_invoices_list(account, created_at DESC, id DESC)`,
`idx_invoices_customer(account, customer, created_at DESC)`.

## `invoice_line_items`

| column | type | notes |
| --- | --- | --- |
| `id` | TEXT PK | `li_...` |
| `invoice` | TEXT NOT NULL → `invoices.id` | `ON DELETE CASCADE` |
| `ordinal` | INTEGER NOT NULL | display order, `UNIQUE (invoice, ordinal)` |
| `meter` | TEXT NOT NULL | |
| `quantity` | INTEGER NOT NULL | aggregated units billed |
| `amount` | INTEGER NOT NULL | minor units, after half-up rounding |
| `currency` | TEXT NOT NULL | |
| `pricing_mode` | TEXT NOT NULL | snapshot of `meters.mode` at invoice time |
| `tier_breakdown` | TEXT NOT NULL | JSON, exactly the API `tiers` array |

One row per meter per invoice is the intended shape (the tier breakdown lives inside the
row). `tier_breakdown` must serialize to the API's `tiers` array, with `amount` =
`units * unit_amount` and the tier amounts summing to the line `amount`:

```json
[{"up_to": 1000, "units": 1000, "unit_amount": 5, "amount": 5000},
 {"up_to": null, "units": 500,  "unit_amount": 2, "amount": 1000}]
```

## `rate_limit_counters`

| column | type | notes |
| --- | --- | --- |
| `api_key` | TEXT NOT NULL | |
| `window_start` | INTEGER NOT NULL | `Math.floor(now_ms / 60000) * 60` (epoch-aligned 60 s window) |
| `count` | INTEGER NOT NULL | requests seen in that window |

Primary key `(api_key, window_start)`. Increment per `/v1/` request; when `count` would
exceed `RATE_LIMIT_PER_MINUTE`, answer `429` problem+json with `Retry-After`. Remaining is
`limit - count` (floor at 0) and `RateLimit-Reset` is the **number of seconds until the
window resets** (`window_start + 60 - now`), not an epoch timestamp — that is what the
IETF draft specifies.

## Pricing worked examples (fixtures)

| case | math | result |
| --- | --- | --- |
| `api_calls`, 1500 units, `acct_demo` (USD, graduated) | `1000 × 5 + 500 × 2` | `6000` minor = `$60.00` |
| `api_calls`, 1500 units, `acct_jpy` (JPY, graduated) | `1000 × 5 + 500 × 2` | `6000` minor = `¥6000` (exponent 0) |
| `storage_gb`, 150 units, `acct_demo` (USD, volume) | total 150 > 100, so all units at 3 | `450` minor = `$4.50` |
| `storage_gb`, 100 units, `acct_demo` (USD, volume) | tier boundary is inclusive: 100 is in the first tier | `100 × 10` = `1000` minor = `$10.00` |

## Fixtures written by the seed (exactly)

| account | api_key | name | currency |
| --- | --- | --- | --- |
| `acct_demo` | `mb_test_demo_key` | Demo account (USD) | `USD` |
| `acct_jpy` | `mb_test_jpy_key` | Demo account (JPY) | `JPY` |

| meter | account | mode | tiers |
| --- | --- | --- | --- |
| `api_calls` | `acct_demo` | graduated | `1000 @ 5`, `null @ 2` |
| `storage_gb` | `acct_demo` | volume | `100 @ 10`, `null @ 3` |
| `api_calls` | `acct_jpy` | graduated | `1000 @ 5`, `null @ 2` |

| customer | account |
| --- | --- |
| `cus_alpha` | `acct_demo` |
| `cus_beta` | `acct_demo` |
| `cus_yen` | `acct_jpy` |

## What the seed does **not** create

`events`, `invoices`, `invoice_line_items`, `idempotency_keys` and `rate_limit_counters`
start empty — tests create their own data through the API. `GET /dashboard?account=acct_demo`
must therefore render an empty invoice list ("no invoices yet" or similar) and still return
`200 text/html`.

## Cursor pagination contract

`GET /v1/invoices` must be stable and gap-free:

- `limit` default 10, clamped to 1..100; invalid values are a `400` problem+json (or clamp —
  but be consistent).
- Order on a total order, e.g. `ORDER BY created_at DESC, id DESC` (the tiebreak matters:
  two invoices created in the same second must still order deterministically).
- `next_cursor` encodes the last row's ordering key (opaque string, e.g. base64url of
  `"<created_at>:<id>"`), and is `null` when `has_more` is false.
- `starting_after=<cursor>` continues **strictly after** that row, so paging never returns a
  duplicate and never skips a row. An unparseable cursor should be `400` problem+json.
- `data` items are invoice objects; `has_more` is a boolean.
