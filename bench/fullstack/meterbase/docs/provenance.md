# Provenance

External specifications consulted for Meterbase (one URL per line, as required by TASK.md):

- https://www.rfc-editor.org/rfc/rfc9457.txt — RFC 9457 Problem Details for HTTP APIs: required members `type`, `title`, `status`, `detail`, `instance`; content type `application/problem+json`; `type` is an absolute URI (we use https://errors.meterbase.dev/...).
- https://www.rfc-editor.org/rfc/rfc6750.txt — RFC 6750 §3: bearer token WWW-Authenticate challenge shape `Bearer realm="...", error="invalid_token", error_description="..."`; example on page 8 matches what the smoke tests assert.
- https://docs.stripe.com/webhooks/signatures — Stripe webhook signature scheme: header `Stripe-Signature: t=timestamp,v1=hex` (multiple entries possible), signed message `timestamp + "." + raw_body`, HMAC-SHA256 with the signing secret as key, timestamp checked against a tolerance (default 5 minutes); we mirror this under the `Meterbase-Signature` header with WEBHOOK_SECRET and WEBHOOK_TOLERANCE_SECONDS.
- https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers — IETF RateLimit-* header draft: quota/remaining and effective window semantics; `RateLimit-Reset` counts seconds until the window resets (delta-seconds), not an absolute epoch timestamp; Retry-After used on throttled responses and takes precedence.
- https://en.wikipedia.org/wiki/ISO_4217 — ISO 4217 reference: the "Exponent" column gives the minor-unit exponent per currency (USD 2, JPY 0, KWD 3; we do not hardcode 2).
