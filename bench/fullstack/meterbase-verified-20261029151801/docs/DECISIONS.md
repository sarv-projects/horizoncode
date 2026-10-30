# Meterbase — implementation decisions

- Idempotency for `POST /v1/events` is stored in the `idempotency_keys` table (account, endpoint, key) with a hash of the raw request body, the original status, body and headers; replay returns the stored response verbatim plus `Idempotent-Replayed: true`, and a different body under the same key returns 409. The partial unique index on `events(account, idempotency_key)` is only a safety net.
- Invoice idempotency keys off `(customer, period_start, period_end)` via the invoices table unique constraint; a repeat request returns the stored invoice with the same 201 and body.
- Pricing is integer minor-unit math only: `units × unit_amount` per tier, half-up rounding at line level (no-op for integer inputs, kept for safety); ISO 4217 exponents (JPY 0, KWD 3, USD 2, …) drive display formatting, never the math.
- Volume mode: the tier whose inclusive `up_to` bound contains the total quantity prices all units; graduated mode: each tier prices only the units inside its own range; every tier row is always emitted (zero units when untouched).
- Cursor pagination orders by `created_at DESC, id DESC`, fetches `limit + 1` rows, and encodes `next_cursor` as base64url(`"<created_at>:<id>"`); `starting_after` resumes strictly after the cursor row.
- Rate limiting is per API key over epoch-aligned 60-second windows in `rate_limit_counters`; `RateLimit-Reset` is seconds until the window reset (delta-seconds per the IETF draft), and 429 responses include `Retry-After`.
- Webhook signatures follow Stripe's scheme (`t=...,v1=...` over `timestamp + "." + payload`, HMAC-SHA256, tolerance check) under the `Meterbase-Signature` header, shared by `/v1/webhooks/sign` and `/v1/webhooks/verify`.
- The dashboard is plain string-concatenated HTML (no build step, no framework), works without JavaScript, and formats money with the account currency's exponent and symbol.
- Errors are RFC 9457 problem details (`application/problem+json`, `type` under https://errors.meterbase.dev/), including the 401 bearer challenge with `WWW-Authenticate: Bearer realm="meterbase", error="invalid_token", error_description="..."`.
