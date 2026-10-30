# meterbase

Skeleton + visible acceptance tests for the Meterbase usage-metering service. `TASK.md`
is the authoritative brief; `docs/SCHEMA.md` documents the seeded SQLite schema. Every
route currently answers `501` `application/problem+json` — implementing them is the job.

```sh
bun run seed   # (re)create $DATA_DIR/meterbase.db with the TASK.md fixtures
bun run start  # http://localhost:$PORT (default 8787); all routes 501 until implemented
bun test       # visible smoke suite — red until TASK.md is implemented
```

Env: `PORT` (8787), `DATA_DIR` (`./.data`), `WEBHOOK_SECRET` (required for webhooks),
`WEBHOOK_TOLERANCE_SECONDS` (300), `RATE_LIMIT_PER_MINUTE` (120).

`bun run seed` is idempotent: it deletes and recreates the database, so rerun it after any
schema change. No dependencies, no install step, no build step.
