# V1 end-to-end acceptance — OpenCode free-model smoke plan (parent-owned)

Status: plan only. NOT RUN. Authorized route: OpenCode provider layer, anonymous free models
(user authorization 2026-10-23). This is the LM-018 real free-model journey. It is the release
smoke, not a substitute for the phase acceptance suites.

## Preconditions (must be true on the exact integrated revision)

1. Kernel lib + test targets compile: `CARGO_TARGET_DIR=target-p2 cargo check --tests` = 0 errors,
   and the migrated lib modules + integration tests pass (P2's wave).
2. `packages/opencode` and `packages/core` typecheck with zero errors in provider/auth/session/tool
   files (P7/P6 waves).
3. Architecture gates stay 0 blockers / 1300-0 / overlay 0-0-0.
4. No other cargo/tsgo process running (one heavy job rule).

## Steps

1. **Enumerate eligible free models offline.** From `packages/opencode`, query the provider catalog
   projection (or the server `/config/providers` route) and record the exact anonymous-eligible
   model refs: active status + complete zero pricing + credential-free + literal `public` token.
   Record the list and the Models.dev provenance (sourceURL, retrievedAt, sha256, freshness).
2. **Start the direct session host** (`bun run --cwd packages/opencode src/index.ts` server or the
   `run` subcommand) inside a repository-local TMPDIR; capture startup log. Confirm the startup
   `ModelsDev.refresh()` fires once and falls back to cache when offline.
3. **Bounded coding journey (LM-018).** Send one short coding task to one eligible free model,
   e.g. "write a function `clamp(v, lo, hi)` with tests, in a scratch file under the repo".
   Bound: 1 session, ≤3 turns, no tools that mutate outside the repo, no payments possible (zero
   pricing only).
4. **Record exact evidence**: selected provider/model ID, route projection digest, request/response
   status, first/last token counts, wall time, and the resulting artifact path + sha256.
5. **Negative probes** (same session host, no restart): (a) attempt a credentialed model → must be
   typed-unavailable before any SDK construction; (b) attempt an env/legacy credential route → must
   be rejected; (c) interrupt mid-response → UNKNOWN, no replay on retry.
6. **Provider-side rejection handling.** If the endpoint rate-limits or rejects the request, the
   honest result is NOT RUN/UNKNOWN with the exact status captured. No identity spoofing, no paid
   fallback, no second route. Record and stop.

## Report shape

Append to `reports/phases/P6.md` (P6 owner) and `reports/phases/LEDGER.md` (parent): exact commands,
model ref, status codes, token counts, evidence artifact digests, negative-probe outcomes, and the
VERIFIED/NOT-VERIFIED verdict for LM-018. V1 stays PARTIAL until the integrated acceptance gates in
`implementationtov1release.md` all pass on the same revision.
