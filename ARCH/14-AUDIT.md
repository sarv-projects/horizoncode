# 14 — Audit (`CMP-audit`)

## Purpose

`CMP-audit` is the **tamper-evident, append-only execution record**. Every
security-relevant effect and every decisive moment — policy decisions, tool calls,
approvals, file writes, sandbox denials, model/provider calls, and cost — is recorded
in a hash-chained log with periodic Merkle roots that are **signed and anchored
beyond the local store**, so history can be verified rather than merely trusted.
A first-class **coverage census** turns "every effect is recorded" from an assertion
into a checkable deliverable (`DEC-005`, `REQ-AUDIT-001`, `REQ-AUDIT-002`,
`REQ-AUDIT-004`, `REQ-AUDIT-005`).

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
- **Sign and anchor** finalized segment roots so tamper-evidence holds against a
  local actor (`REQ-AUDIT-004`).
- Publish a first-class **coverage census** mapping every declared security-relevant
  effect class to at least one recorded entry (`REQ-AUDIT-005`).
- Maintain the **cross-store consistency invariant** with the session log and the
  analytics ledger (`REQ-AUDIT-006`, `DEC-020`).
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

**What verify proves:** given a trusted anchor, no entry has been added, removed,
reordered, truncated, or modified without detection, every entry is included in its
segment root, and every root signature verifies.
**What verify does not prove:** that the recorded content is truthful, that no
unrecorded effect occurred elsewhere, or who authored an entry. Coverage is a
separate **census** (`REQ-AUDIT-005`), and root-anchoring is only as strong as the
trusted key/sink it anchors to (`REQ-AUDIT-004`). A run with only a local anchor is
reported as **local-trust**, never as independently anchored.

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

## Root anchoring (signed / off-box)

Local roots detect local tampering only. To make tamper-evidence meaningful against a
local actor, `CMP-audit` **signs and anchors** every finalized `SegmentRoots`
(`REQ-AUDIT-004`):

- **Local root chain.** Each root is appended to `roots.jsonl` and chain-linked by
  `prev_root`, so deleting or editing a root breaks the root chain.
- **Signed roots.** Each root is signed with a device key held by `CMP-secrets`; the
  signature covers `{segment, first_seq, last_seq, count, merkle_root, prev_root}`.
  `audit verify` checks signatures as well as hashes.
- **Off-box anchor.** On a configured cadence or at a session-close boundary, the
  signed root is exported to a user-nominated external sink (append-only file, remote
  object, or counter-signing service). The sink is transport behind an adapter and
  receives roots and signatures only — never entries.
- **What anchoring buys.** Given a trusted anchor, a local actor who rewrites entries
  and recomputes local roots is still detected: the anchor's root no longer matches.
  It does not prove the content is truthful, and it is only as strong as the trust in
  the anchor key and sink, which is documented per deployment.

Absent an anchor, roots are **local-only** and `verify` labels the evidence
`local-trust`; it never presents local roots as independently anchored.

## Coverage census

`REQ-AUDIT-001` is only meaningful if coverage is checkable, so `CMP-audit` ships a
first-class **coverage census** (`REQ-AUDIT-005`):

- A declared registry of **security-relevant effect classes**; the "What is recorded"
  table is its seed, and additions are data, not prose.
- A census command that, over a bounded window or segment set, maps every declared
  class to at least one recorded entry and reports per-class counts.
- Any uncovered declared class fails loudly (non-zero, audited); an uncovered class is
  a defect, not an accepted gap.
- The census output is a generated artifact that can accompany a release or a session
  bundle as evidence.

The census proves *that* every declared class is represented; it does not by itself
prove that no undeclared class exists — the declared registry is reviewed as part of
the security boundary.

## Cross-store consistency (single store vs. multiple)

`DEC-020` fixes the answer: **multiple append-only stores, one invariant.** The stores
are:

| Store | Owner | Role | Ordering |
|---|---|---|---|
| `log.jsonl` (session event log) | `CMP-session` | replay source of truth | per-session dense `seq` |
| `segments/*.jsonl` + `roots.jsonl` | `CMP-audit` | independently verifiable evidence | global audit `seq`; chain-linked roots |
| `events.jsonl` (analytics ledger) | `CMP-analytics` | rebuildable rollups | derived; coalesced appends |

Invariant (`REQ-AUDIT-006`):

1. A security-relevant effect is **complete** only once its audit entry is durably
   chained; a session or analytics fact that references it carries `session_id`, the
   session `seq`, and the audit `seq` (or `receipt_ref`).
2. Each store's own monotonic sequence defines its internal order. **Cross-store
   ordering is never inferred from wall-clock time**; the audit `seq` is the
   authoritative tie-break for security-relevant ordering, and the session/analytics
   stores carry their own sequence for their internal use.
3. A reconciliation check flags any referenced effect with no audit entry and any
   audit entry whose referenced session fact is missing; disagreement is surfaced,
   never silently merged.
4. Retention is per-store: the audit chain is never pruned with the session log or the
   analytics ledger, and analytics remains rebuildable without the audit chain.

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
    "anchor": {
      "sign": true,
      "offbox": "none",                         // none (local-trust) | file | remote
      "cadence": "session_close"                // session_close | every_n_segments
    },
    "retention": { "mode": "preserve" },      // preserve | archive with proof
    "export": { "require_chain_proof": true }
  }
}
```

## Requirements mapping

| REQ | How this module satisfies it |
|---|---|
| `REQ-AUDIT-001` | Every declared security-relevant effect class appends exactly one entry; the coverage census checks the mapping. |
| `REQ-AUDIT-002` | Hash chain + Merkle roots with an `audit verify` command that states what it does and does not prove. |
| `REQ-AUDIT-003` | `CMP-secrets` redaction pass before any entry is chained. |
| `REQ-AUDIT-004` | Segment roots are signed and anchored off-box; unanchored runs are labeled local-trust. |
| `REQ-AUDIT-005` | First-class coverage census maps every declared effect class to entries and fails on a gap. |
| `REQ-AUDIT-006` | Cross-store consistency invariant with the session log and analytics ledger (`DEC-020`). |
| `REQ-PROV-004` | Credentials never appear in audit entries; provider calls logged as counts/refs only. |
| `REQ-SESS-002` | Replay reconstructs a session timeline from persisted evidence. |
| `REQ-SESS-004` | Model, mode, and permission configuration recorded with the session. |
| `REQ-HORIZON-003` | Cost entries feed enforceable, fail-closed budgets. |
| `REQ-LOOP-004` | Each turn's terminal state is recorded as an audited boundary. |

## Open questions

1. **Root anchoring defaults** — the mechanism is decided (sign + optional off-box
   anchor; see "Root anchoring"); the open items are the default sink/trust model per
   deployment, the default anchor cadence, and device-key rotation/escrow for the
   signing key.
2. **Retention vs. portability** — how long full entries are preserved versus a
   roots-plus-receipts archive, and how a truncated archive still proves the range it
   covers.
3. **PII redaction policy** — the exact field allowlist for `meta` and whether
   workspace-relative path normalization is always safe across multi-root workspaces.
4. **Verify performance at scale** — incremental verification from a trusted
   checkpoint versus full-chain recomputation for very long sessions.
5. **Audit of audit** — whether `verify`/`replay`/export operations themselves append
   entries (proposed: yes for export, to record access).
