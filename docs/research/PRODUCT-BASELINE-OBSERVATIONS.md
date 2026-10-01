# Product baseline observations

**Source status (2026-09-28, `AX-348` byte-admission slice).** `horizoncode-artifact`
implements the write/read core: streaming `put` that hashes and enforces the
`DEC-058` object and namespace ceilings while reading (never buffering or truncating
an over-cap payload), exclusive owner-only staging published by digest with an
existing digest path re-verified rather than replaced, a durable per-namespace quota
ledger, idempotency by operation id with a typed conflict on different bytes, and
`read`/`stat`/`list` that verify digest and length and return typed
missing/corrupt/unsupported/over-limit states. State paths use the shared hygiene
primitive (`AX-126`): symlinked namespaces, staging, quota, lock, and object paths
are refused, and created files/directories are owner-only. **Not implemented:**
reference leases and the owner graph, GC mark/delete (including the
incomplete-enumeration abort), decoders for `max_decoded_bytes`/pixels/expansion,
export/import, the physical control reserve, and the Thread/Run integration that
appends the reference only after the bytes are durable.


**Current source status at `80400370c7898459f7e7c24642caba9af31379d1`:** the ACP crate is a
server-only v1 edge. It implements `initialize`, `session/new`, `session/prompt`,
`session/cancel`, `session/close`, streamed `session/update`, and
`session/request_permission`; it advertises only the implemented prompt capability.
It does not implement `session/load`, `session/resume`, `session/list`, `session/fork`,
an outbound ACP client, or a peer reconnect path. See `crates/horizoncode-acp/src/lib.rs`,
`server.rs`, and `ARCH/integrations/PROTOCOLS.md`. The lifecycle/client behavior in this section is a target
contract, not current capability.

