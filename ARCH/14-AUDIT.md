# 14 — Audit (`CMP-audit`)

## Purpose

`CMP-audit` is the **tamper-evident, append-only execution record**. Every
security-relevant effect and every decisive moment — policy decisions, tool calls,
approvals, file writes, sandbox denials, model/provider calls, and cost — is recorded
in a hash-chained log with periodic Merkle roots, so history can be verified rather
than merely trusted (`DEC-005`, `REQ-AUDIT-001`, `REQ-AUDIT-002`).

The audit store is **not** the session event log. `CMP-session` owns replayable
session events; `CMP-audit` owns independently verifiable evidence and is not pruned
with operational events. Audit reads are themselves access-controlled
(`REQ-AUDIT-003`).

## Responsibilities

- Append one immutable entry per recorded decision/effect, chained to its predecessor.
- Compute and persist periodic **Merkle roots** over entry batches.
- Provide a **verify** command that recomputes the chain and roots and reports any
  tampering, deletion, reorder, or truncation.
- Provide a **replay** command that reconstructs the decision/effect timeline of a
  session from its entries.
- Guarantee **secret redaction**: credentials never enter an entry
  (`REQ-PROV-004`, `REQ-AUDIT-003`).
- Reference durable receipts for effects rather than duplicating payloads.
- Keep the record portable with the session bundle.

**Never owns:** session event replay (`CMP-session`), receipts/artifacts
(`CMP-tools`/persistence), policy evaluation (`CMP-guard`), or credential custody
(`CMP-secrets`).

## Interfaces

| Peer (`CMP-*`) | Direction | Contract |
|---|---|---|
| `CMP-guard` | inbound | decision records: allow/ask/deny, ticket issue/validate/revoke, mode changes |
| `CMP-sandbox` | inbound | profile-applied, apply-failed, fs/net violations |
| `CMP-tools` | inbound | tool proposed/started/completed, file write, patch apply; receipt refs |
| `CMP-provider` | inbound | model call (provider/model id, token counts, cost), no prompt/completion content |
| `CMP-runner` | inbound | run/step boundaries, terminal state, step receipts |
| `CMP-secrets` | outbound | redaction pass applied before an entry is chained |
| `CMP-session` | both | session id/ref association; audit accompanies a portable session bundle |
| `CMP-tui` / `CMP-headless` | outbound | verify/replay invocations and status |

## Data / state model

```
AuditEntry = {
  seq:          u64,              // monotonic within the segment
  session:      SessionId,
  ts:           epoch_ms,         // UTC
  actor:        user | agent | system | workflow,
  kind:         decision | tool | approval | fs_write | sandbox | model | cost | ticket,
  action?:      string,
  resource?:    string,           // ref/glob form, never raw payload
  effect?:      allow | ask | deny,
  outcome?:     ok | denied | error | timeout,
  ticket_ref?,  approval_ref?,    receipt_ref?, work_id?, run_id?,
  inputs_digest?: blake3,         // effect/argument digest
  meta:         bounded,          // small typed fields only
  prev_hash:    blake3,           // previous entry_hash in the chain
  entry_hash:   blake3            // blake3(canonical(entry \ entry_hash) || prev_hash)
}
SegmentRoots = { segment: u32, first_seq, last_seq, count, merkle_root, prev_root? }
```

- `blake3` is the hashing dependency (`ARCH/03` §5). Entries are canonicalized
  (stable field order, no floats) before hashing so verification is deterministic.
- The chain crosses segment boundaries: the first entry of a segment references the
  last entry hash of the previous segment, and the segment Merkle root is recorded.
- Entries carry **refs, digests, and bounded metadata**, never documents, file
  bodies, prompt text, or completion text.

## What is recorded

| Class | Examples |
|---|---|
| Decisions | Every `allow`/`ask`/`deny`, plus timeouts and mode changes |
| Tool calls | Tool name, argument digest, start/end, outcome, receipt ref |
| Approvals | Request, the exact remembered pattern, reply (`once`/`always`/`reject`), timestamp |
| File writes | Path (workspace-relative), pre/post content digest, lease/conflict outcome |
| Sandbox denials | Profile applied/failed, fs/net violations, refused unconfined requests |
| Model / provider calls | Provider + model id, token counts, latency, routing decision — counts and refs only |
| Cost | Estimated cost per call and per run, feeding budget enforcement |
| Ticket lifecycle | Issue, validate, use decrement, expiry, revocation, epoch bump |

**Step receipts:** each settled step records a receipt ref (ticket, capability/
provider, inputs digest, outputs refs, verification performed). The audit entry
stores the ref; the receipt store holds the detail. Denials and destructive actions
are first-class entries, never omitted.

## Secret redaction guarantees

- `CMP-secrets` performs a redaction pass on the canonicalized entry **before**
  hashing and append; a value that fails the redaction check is replaced by a typed
  placeholder, and the redaction itself is noted (not the secret).
- Secrets are never written to the chain, roots, verify output, replay output, or any
  derived export. Credentials exist only in the vault.
- Redaction covers environment-derived values, URL userinfo, authorization headers,
  and any field whose name matches the secret pattern set.

## Lifecycle & flows

### Append
1. Producer submits an event with refs and bounded metadata.
2. Canonicalize and run the redaction pass.
3. Read the current chain head; compute `entry_hash` from the entry and `prev_hash`.
4. Persist the entry and advance the head under an exclusive append lock.
5. When a segment reaches its rollover threshold, finalize it and persist its
   `SegmentRoots` record.

### Verify
```
agentx audit verify [--session <id>] [--all]
```
Recomputes each `entry_hash` from stored bytes and `prev_hash`, checks contiguity of
`seq`, recomputes every segment Merkle root, and confirms root linkage across
segments.

**What verify proves:** given the recorded roots, no entry has been added, removed,
reordered, truncated, or modified without detection, and every entry is included in
its segment root.
**What verify does not prove:** that the recorded content is truthful, that no
unrecorded effect occurred elsewhere, or who authored an entry. Coverage (every
effect has an entry) is a separate census, and root-anchoring is only as strong as
where the root lives (local roots detect local tampering; an off-box anchor is an
open question).

### Replay
```
agentx audit replay --session <id> [--from <seq>] [--to <seq>]
```
Prints the reconstructable decision/effect timeline (decisions, tickets, tool
outcomes, approvals, cost) in order. Replay reads evidence; it does not re-execute
effects.

### Session portability
A portable session bundle includes its audit entries, segment roots, and a proof
header. Import **verifies the chain before trusting it**; a bundle whose chain fails
verification is rejected or quarantined with the failure surfaced. The audit record
carries the model, mode, and policy snapshot the session ran under, so a restarted or
moved session remains reconstructable and its decisions reproducible
(`REQ-SESS-002`, `REQ-SESS-004`).

## Storage layout and rotation

```
<state-dir>/audit/
  segments/0000.jsonl      # append-only, one canonical entry per line
  segments/0001.jsonl
  roots.jsonl              # one SegmentRoots record per finalized segment
  head                     # current segment + last entry hash (atomic replace)
```

- Segments roll over at a fixed entry count or byte budget (configurable).
- Finalized segments are immutable; rotation never rewrites or compacts a segment.
- The audit store is **excluded from operational-event retention**; it is pruned only
  by an explicit archival/retention policy that preserves verifiability.
- The `head` pointer is updated by atomic replace so a crash cannot silently drop the
  chain; a torn tail is detected at verify and truncated to the last valid entry with
  an audit note.

## Privacy / PII handling

- Entries store digests and refs, not user content; prompt/completion text is never
  recorded (counts and ids only).
- PII minimization is structural: paths are workspace-relative where possible, and
  external targets are stored as normalized host/`host:port` rather than full URLs.
- Reads/exports are access-controlled; an export carries the chain proof so a
  recipient can verify it without trusting the exporter.

## Failure modes

| Failure | Behavior |
|---|---|
| Append I/O error | Fail the guarded action closed; surface the error; do not proceed unrecorded |
| Redaction error | Refuse the entry; never chain a possibly-secret payload |
| Torn tail after crash | Verify truncates to the last valid entry and records the repair as a new entry |
| Tamper detected | Verify reports the failing `seq` and stops; replay refuses to assert trusted history |
| Root store missing | Segment treated as unanchored; verify reports the gap; never fabricates a root |
| Disk full / rotation failure | Bounded error; the effect is denied rather than committed unrecorded |
| Portable bundle fails verify | Reject or quarantine; surface the reason; never silently import |

## Configuration

```jsonc
{
  "audit": {
    "enabled": true,
    "segment_max_entries": 4096,
    "segment_max_bytes": 8388608,
    "hash": "blake3",
    "retention": { "mode": "preserve" },      // preserve | archive with proof
    "export": { "require_chain_proof": true }
  }
}
```

## Requirements mapping

| REQ | How this module satisfies it |
|---|---|
| `REQ-AUDIT-001` | Every security-relevant effect appends to the append-only log. |
| `REQ-AUDIT-002` | Hash chain + Merkle roots with an `audit verify` command. |
| `REQ-AUDIT-003` | `CMP-secrets` redaction pass before any entry is chained. |
| `REQ-PROV-004` | Credentials never appear in audit entries; provider calls logged as counts/refs only. |
| `REQ-SESS-002` | Replay reconstructs a session timeline from persisted evidence. |
| `REQ-SESS-004` | Model, mode, and permission configuration recorded with the session. |
| `REQ-HORIZON-003` | Cost entries feed enforceable, fail-closed budgets. |
| `REQ-LOOP-004` | Each turn's terminal state is recorded as an audited boundary. |

## Open questions

1. **Root anchoring** — whether the periodic Merkle root is anchored off-box (signed
   or co-signed) to strengthen tamper evidence beyond local detection.
2. **Retention vs. portability** — how long full entries are preserved versus a
   roots-plus-receipts archive, and how a truncated archive still proves the range it
   covers.
3. **PII redaction policy** — the exact field allowlist for `meta` and whether
   workspace-relative path normalization is always safe across multi-root workspaces.
4. **Verify performance at scale** — incremental verification from a trusted
   checkpoint versus full-chain recomputation for very long sessions.
5. **Audit of audit** — whether `verify`/`replay`/export operations themselves append
   entries (proposed: yes for export, to record access).
