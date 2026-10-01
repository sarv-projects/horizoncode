# Events

## Owner envelope

Canonical events use `{schema_version, owner_kind, owner_id, seq, event_id, event_type, actor_ref, causation_id?, correlation_id?, payload_digest, previous_event_digest, event_digest, payload|payload_ref}`. Payload representation is versioned, bounded and digest-verified. Sequence is monotonic only within its owner stream; no global order across Thread, Run and audit streams is invented.

CMP-session owns Thread events; CMP-orch owns Run/control streams; CMP-audit owns audit entries; CMP-memory owns its transactional records/events. Producers submit through the owner API, never write store files themselves. Event type catalogs and versioned payload schemas are part of each owner's contract and migrated without changing already-hashed bytes.

## Commit and delivery

Artifact bytes and required namespace durability precede an event referring to them. Acknowledgement follows durable committed-head publication. Projection advancement follows that commit. A crash may leave held/reconciling operations; it cannot convert uncommitted records into authority. Replaying known committed events must reconstruct the same projection without repeating settled effects.

Durable client events carry aggregate cursor and commit identity. Ephemeral deltas carry subscription-local sequence and the durable cursor at emission, never a fabricated canonical event sequence. Coalescing is bounded and explicitly signals gaps. Priority cancellation, permission and question lanes have reserved capacity. A durable gap requires resnapshot before dependent mutation.

Canonical Thread vocabulary is slash-delimited (`thread/created`, `assistant/attempt`, `tool/call`, `tool/result`, `compaction/started`, `compaction/committed`). Persisted Run kinds use the versioned orchestration event registry. Logical record labels are not implicit wire spellings. Legacy session-named bytes remain unchanged under migration.

## Shared log metadata

`CMP-session` and `CMP-orch` use the same versioned log-framing records. This registry
owns their field shape; each stream owner owns its own bytes, sequence, commit and
migration. `THREAD` and `RUN` are the canonical owner kinds. A legacy `SESSION` value
may be read only by the versioned migration path and is rewritten into the destination
Thread identity without changing the source bytes.

```text
LogSegmentSealV1 {
  owner_kind: THREAD|RUN,
  owner_id: ThreadId|RunId,
  segment_id: SegmentId,
  first_seq: OwnerSeq,
  last_seq: OwnerSeq,
  event_count: bounded_integer,
  encoded_bytes: bounded_integer,
  first_event_digest: Digest,
  last_event_digest: Digest,
  predecessor_segment_digest?: Digest,
  segment_digest: Digest,
  schema_version: 1
}

CommittedLogHeadV1 {
  owner_kind: THREAD|RUN,
  owner_id: ThreadId|RunId,
  generation: u64,
  committed_seq: OwnerSeq,
  committed_event_digest: Digest,
  committed_segment_digest?: Digest,
  durability_profile: DurabilityProfileId,
  updated_at: Timestamp
}

PortableRunBundleV1 {
  run_id: RunId,
  source_revision: RevisionRef,
  committed_head: CommittedLogHeadV1,
  segment_seals: LogSegmentSealV1[],
  artifact_manifest: ArtifactRef[],
  redaction_anchor_level: RedactionAnchorPolicy,
  environment_assumptions: EnvironmentSnapshotRef[],
  bundle_digest: Digest
}
```

A portable bundle includes the committed head and seals, artifact manifest,
redaction/anchor policy and environment assumptions. Copying a Thread transcript or
Run log alone does not produce a portable managed Run. Import creates new identities
and cannot transfer authority, approval, budget spend, or PASS evidence without
revalidation under the destination requirements and revision.
