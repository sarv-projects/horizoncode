# docs

`SCHEMA.md` describes the seeded SQLite schema — read it before querying the database so
you do not have to reverse-engineer `src/seed.ts`. Before you finish you must add two
files yourself (they are intentionally absent): `docs/provenance.md` — every URL you
actually opened, one per line, with a one-line note on what you took from it (the external
specs named in `TASK.md`: Stripe webhook signatures, RFC 9457, RFC 6750 §3, the IETF
`RateLimit-*` draft, ISO 4217 exponents) — and `docs/DECISIONS.md`, 5–10 short bullets on
the choices you made (idempotency storage, cursor encoding, rounding, tier math,
rate-limit window, currency exponent source, HTML rendering, etc.).
