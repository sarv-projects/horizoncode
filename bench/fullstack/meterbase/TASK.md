# Meterbase — usage metering & invoicing service

You are the second backend engineer at Meterbase (Series A, ~40 people). Our
customers send us metered usage events (API calls, seats, GB stored) and we bill
them monthly. A previous contractor left us a skeleton and a `TASK.md`; the
service is not implemented. Build it.

Everything you need is in this directory. Do not modify anything outside it.

## Stack and constraints

- **Bun + TypeScript only.** No `npm install` — there are no runtime
  dependencies. Use `Bun.serve` for HTTP and `bun:sqlite` for storage.
- `bun run start` must serve on `process.env.PORT` (default `8787`).
- Persistence in `process.env.DATA_DIR` (default `./.data`); create it if
  missing. State must survive a process restart.
- `bun test` runs the test suite. Keep the existing tests passing and add your
  own.
- Money is always integer **minor units** of an ISO 4217 currency. Never use
  floats for money.

## Product requirements

### Auth
Every request under `/v1/` requires `Authorization: Bearer <api_key>`. Keys
live in the `accounts` table (`id`, `api_key`, `name`, `currency`). A missing or
unknown token must be rejected with **401** and a `WWW-Authenticate` challenge
that is RFC 6750 §3 compliant (`realm`, `error="invalid_token"`, plus
`error_description`). `GET /dashboard` is public.

### `POST /v1/events`
Ingest one usage event.

```json
{ "meter": "api_calls", "customer": "cus_123", "quantity": 42, "timestamp": 1730000000 }
```

- `Idempotency-Key` header is **required** for this endpoint; a request without
  it is a `400` problem.
- Replaying the same key with the same body must return the **identical status
  and body** as the first request, plus `Idempotent-Replayed: true`.
- Replaying the same key with a **different** body must fail with `409`.
- `timestamp` is optional (Unix seconds, defaults to now). Events outside the
  current billing period are still accepted.
- Response `201` with `{ "object": "event", "id": "evt_...", "meter": ...,
  "customer": ..., "quantity": ..., "timestamp": ... }`.

### Pricing
Meters are configured in `meters` (`id`, `account`, `currency`, `mode`,
`tiers` JSON). Two modes:

- `graduated` — each tier applies only to the units inside its own range.
- `volume` — the tier the total quantity lands in applies to **all** units.

A tier is `{ "up_to": 1000, "unit_amount": 5 }`; `up_to: null` means infinity.
`unit_amount` is minor units per unit. Bill each customer/meter once per period.

### `GET /v1/usage`
Query: `meter`, `customer`, `from`, `to` (Unix seconds, optional). Returns
aggregated quantity plus a per-tier breakdown consistent with the pricing mode.

### `POST /v1/invoices`
Generate an invoice for a billing period.

```json
{ "customer": "cus_123", "period_start": 1730419200, "period_end": 1733011200 }
```

- Line items per meter with `quantity`, `amount` (minor units), and the tier
  breakdown that produced the amount.
- Rounding: half-up at the line level. Respect the currency's minor-unit
  exponent (JPY has 0, KWD has 3, USD has 2) — do not assume 2.
- Idempotent per `(customer, period_start, period_end)`: a second identical
  request returns the same invoice, not a duplicate.

### `GET /v1/invoices`
Stripe-style cursor pagination: `limit` (default 10, max 100),
`starting_after`. Response:

```json
{ "object": "list", "data": [...], "has_more": false, "next_cursor": null }
```

Ordering must be stable and `next_cursor` must round-trip through
`starting_after` without duplicates or gaps.

### Response shapes (exact field names)

`GET /v1/usage` → `200`

```json
{ "object": "usage", "meter": "api_calls", "customer": "cus_alpha",
  "from": 1730000000, "to": 1732000000, "quantity": 1500, "amount": 6000,
  "pricing_mode": "graduated",
  "tiers": [ { "up_to": 1000, "units": 1000, "unit_amount": 5, "amount": 5000 },
             { "up_to": null, "units": 500,  "unit_amount": 2, "amount": 1000 } ] }
```

`POST /v1/invoices` → `201` (an idempotent replay returns the same invoice with
the same `201` and the same body)

```json
{ "object": "invoice", "id": "inv_...", "customer": "cus_alpha", "currency": "USD",
  "period_start": 1730000000, "period_end": 1732000000, "status": "open",
  "subtotal": 6000, "total": 6000,
  "line_items": [ { "meter": "api_calls", "quantity": 1500, "amount": 6000,
                    "pricing_mode": "graduated",
                    "tiers": [ { "up_to": 1000, "units": 1000, "unit_amount": 5, "amount": 5000 },
                               { "up_to": null, "units": 500,  "unit_amount": 2, "amount": 1000 } ] } ] }
```

A tier row's `amount` is `units * unit_amount`; `subtotal` and `total` are the
sum of the line-item amounts (no tax in scope).

### `POST /v1/webhooks/verify`
Our customers' billing systems verify our webhooks with the **Stripe-compatible
signature scheme** that they already use everywhere else — do not invent one.
We send header `Meterbase-Signature`. This endpoint receives
`{ "payload": "<raw body string>", "signature_header": "..." }` and must answer
`200 { "valid": true }` only for a signature that a correct Stripe-compatible
verifier would accept, and `400 { "valid": false, "reason": "..." }` otherwise.
Tolerance is `WEBHOOK_TOLERANCE_SECONDS` (default `300`).

Also expose `POST /v1/webhooks/sign` (`{ "payload": "..." }` → `{ "header":
"..." }`) using `WEBHOOK_SECRET` so the same code path is testable in both
directions.

### Errors
Every error response — 4xx and 5xx — must be **RFC 9457 problem details**:
`Content-Type: application/problem+json` and members `type` (absolute URI),
`title`, `status`, `detail`, `instance`. Use `type` values under
`https://errors.meterbase.dev/`.

### Rate limiting
Per API key: `RATE_LIMIT_PER_MINUTE` (default 120). Expose the standard
`RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` response headers
on `/v1/` responses, and `429` (problem details) with `Retry-After` when
exceeded. Follow the published IETF rate-limit header semantics, including what
`RateLimit-Reset` counts.

### Dashboard
`GET /dashboard?account=<id>` returns a server-rendered HTML page (no build
step, no framework) that lists the account's invoices with id, total (formatted
in the account currency) and period, and shows current-period usage per meter.
It must work with JavaScript disabled.

## Fixtures

`bun run seed` must (re)create the local database idempotently with exactly
these rows, so the whole team can share test data:

| account | api_key | currency |
| --- | --- | --- |
| `acct_demo` | `mb_test_demo_key` | `USD` |
| `acct_jpy` | `mb_test_jpy_key` | `JPY` |

| meter | account | mode | tiers |
| --- | --- | --- | --- |
| `api_calls` | `acct_demo` | `graduated` | `1000 @ 5`, `null @ 2` |
| `storage_gb` | `acct_demo` | `volume` | `100 @ 10`, `null @ 3` |
| `api_calls` | `acct_jpy` | `graduated` | `1000 @ 5`, `null @ 2` |

Customers: `cus_alpha` and `cus_beta` on `acct_demo`; `cus_yen` on `acct_jpy`.

## Documentation requirement (do not skip)

Several of the formats above are defined by external specifications and vendor
docs, and getting them subtly wrong breaks customer integrations. **Consult the
published documentation rather than recalling it from memory** — this is exactly
the kind of detail that has to be looked up, not guessed:

- Stripe's webhook signature scheme (canonicalization, header format, tolerance,
  multiple signature entries).
- RFC 9457 problem details for HTTP APIs.
- RFC 6750 §3 `WWW-Authenticate` challenge for bearer tokens.
- The IETF `RateLimit-*` header field draft.
- ISO 4217 minor-unit exponents.

Record every URL you actually opened in `docs/provenance.md`, one per line, with
a one-line note on what you took from it. Do not list URLs you did not open.

## Definition of done

- `bun run start` serves the API; `bun test` passes.
- All routes above implemented and coherent with each other.
- `docs/provenance.md` present and accurate.
- `docs/DECISIONS.md` with 5-10 short bullets on the choices you made.
