---
contract: canonical
owner: CMP-memory
requirements: [REQ-MEM-001, REQ-MEM-002, REQ-MEM-003, REQ-MEM-004, REQ-MEM-005, REQ-MEM-006, REQ-MEM-007]
---
# Memory

## Purpose

Remember useful preferences and project lessons across conversations while allowing fast correction. Memory is contextual information, never permission, canonical task truth, or verification evidence. Explicit saves need no redundant approval. Automatic notes remain visibly inferred and cannot silently become user-confirmed facts.

## Ownership

CMP-memory owns records, revisions, retrieval, conflicts, deletion and its SQLite event history. CMP-session owns ProjectIdentity and Thread history. CMP-config owns validated memory settings. CMP-context selects bounded sources and binds their revisions to ContextEpoch. CMP-orch admits child context; CMP-guard authorizes effects; CMP-verifier establishes evidence. No memory service creates another project identity resolver, policy engine, scheduler or completion authority.

ExecutionBrief is short-term Run working state reconstructed from canonical owners. Drafts, recaps and historical messages remain their respective owners' records. Automatic capture cannot convert a task status, credential, approval or worker claim into durable memory truth.

## Architecture

Memory has three admission classes:

| Class | Admission | Retrieval |
|---|---|---|
| User-directed preference or note | A direct `/memory remember` action, or admitted explicit user request, commits the requested wording with user provenance | Relevant scoped context; latest explicit instruction wins |
| Ambient project observation | Automatic bounded capture commits an advisory record with evidence, inferred origin and passive Undo | Advisory context only; source and uncertainty remain visible |
| Unverified decision or sensitive assertion | Candidate requiring exact revision review, or rejection when secrets/authority claims are involved | Excluded until appropriate admission; admission never grants authority |

Default mode is `ambient`: local project advisory capture and explicit saves are enabled, subject to managed policy. `explicit` permits only user-directed saves; `off` disables automatic capture and retrieval. Automatic capture is limited to project-local preferences, feedback and repository observations. No automatic user-global inference occurs. A first-use explanation and persistent `/memory` mode control disclose this behavior without a blocking onboarding dialog. Existing stores migrate with their previous effective mode; upgrades do not silently enable capture.

An inferred preference is a hint, not a confirmed preference. Framework selection can change build behavior and is never blindly applied against the user's task or repository configuration. Security, authentication and architectural decisions are not automatically classified safe because their wording resembles style. Secrets are never memory; approved secret references remain owned by the secret broker.

## Public contracts

`remember(scope, text, expected_scope_revision, request_id, user_intent_ref)` validates scope and admitted user intent; it directly saves explicit content. A model cannot manufacture the intent reference. Ambiguous save wording or scope prompts one clarification, not a candidate-approval ceremony. Model embellishment beyond requested content is a separate inferred note or reviewable candidate.

`capture(observations, policy_digest, scope, request_id)` admits only whitelisted advisory kinds and source references. It rejects authority changes, executable instructions, transient status and unsupported scope expansion. `retrieve(query, ContextScope, ContextEpoch)` returns bounded records and omission reasons. `edit(id, expected_revision, content)`, `forget(id, expected_revision)`, `dismiss(id, expected_revision)`, `review(candidate, expected_revision)` and `purge(scope, expected_scope_revision)` return durable receipts. Repeat request IDs resolve the same outcome.

`learn(workspace, bounds, request_id)` performs cancellable read-only repository analysis through repo-intelligence and authorized file readers. It produces advisory naming/layout/test-tooling observations with exact source views. It never starts tests, executes package scripts, crawls unrelated directories or sends data to an extra model service implicitly. Rule-file export is Preview then Apply through the existing file-effect path; repository instruction files are never silently rewritten. `/analyze` is an alias for `/learn` in this flow.

## Data model

```text
MemoryRecordV2 {
 memory_id, revision, schema_version,
 scope: user | project, scope_id, agent_profile_id?,
 kind: preference | feedback | workflow | repo_observation | decision | pointer,
 admission: user_directed | advisory_auto | reviewed,
 state: active | candidate | rejected | superseded | expired | deleted,
 content, content_digest,
 origin: explicit_user | repository_analysis | conversation_observation | imported | child,
 source_refs[], user_intent_ref?, admission_principal?, policy_digest,
 freshness: current | changed | unavailable | unverified | contradicted,
 applicability_key?, confidence_band?: low | medium | high,
 created_seq, updated_seq, expires_at?, supersedes_id?,
 capture_generation, last_validated_seq?, last_retrieved_at?
}
MemorySourceRef {
 store, aggregate_type, aggregate_id, aggregate_seq, event_id,
 project_id?, workspace_id?, source_revision?,
 source_view?: committed | working_tree | editor_buffer,
 path?, file_digest?, dirty_generation?, buffer_digest?, span_digest?
}
ContextScope {
 scope_id, user_scope_id, project_id?, agent_profile_id?, run_id?,
 retrieval_policy_digest, excluded_projects[], kinds[],
 max_records, max_bytes, max_tokens, capture_generation
}
MemoryReceipt {
 request_id, memory_id?, revision?, committed_seq?, outcome,
 audit_delivery: pending | delivered | unavailable
}
```

Content is bounded UTF-8; digests name their algorithm. Confidence bands are advisory evidence-quality labels, not calibrated probability or authorization. A stable applicability key enables deduplication and explicit conflict sets; arbitrary model text cannot create policy keys.

ProjectIdentity is the shared opaque identity from the session workspace registry. Worktrees inherit admitted project identity; separate clones remain separate unless the user explicitly links them. Basenames and credential-bearing remote URLs are never identity keys. Missing, ambiguous, unsafe or incompatible mapping disables affected project operations with visible recovery guidance.

## Storage and transitions

A versioned local SQLite database owns an append-only memory_event sequence. Each write commits event, record revision, FTS projection, deletion tombstone and durable outbox in one transaction. Thread, Run and audit references are delivered idempotently; no cross-store atomicity is claimed. Audit pending never undoes a committed deletion.

User-directed save becomes active/user_directed. Automatic capture becomes active/advisory_auto. Restricted assertions become candidate; exact review becomes active/reviewed or rejected. Edit creates a revision; explicit replacement supersedes the prior record. Forget deletes content and search entries; dismiss suppresses an advisory pattern without retaining its text. Expiry and supersession prevent selection. Revalidation appends a new evidence-bound revision; it never overwrites source lineage. Imported records retain foreign origin and enter advisory or candidate admission, never fabricated user confirmation.

Bounded maintenance merges exact duplicates by digest while preserving references. Semantic consolidation may create a replacement advisory proposal but cannot silently rewrite explicit preferences or erase their lineage. Store capacity never silently evicts user-directed records. Retention settings may expire advisory records; deletion semantics remain visible.

## Normal flows

Explicit save: user requests memory → validate intent/scope and sensitive-data filters → commit → show compact “Remembered for this project” with Edit and Forget → continue. Missing scope uses project when available; user-global scope requires explicit selection. Without a project, ambiguous project-specific content asks for scope rather than becoming global.

Automatic capture: eligible completed user interaction or bounded repository analysis → background extraction under resource ceilings → admission classification → commit advisory record → passive activity indication with Undo → continue. Captures are batched; they never delay sending, token streaming, cancellation or approval. Model calls for extraction use the active authorized route and explicit budget; they do not create undisclosed remote services.

Recall: resolve scope → filter admission/state/privacy/deletion → check applicability and source freshness → rank deterministically with explicit relevance → reserve byte/token budget → return IDs/revisions/digests → persist ContextEpoch selection → display inspectable “Memory used” source indicator. Context inspection shows why each source was included or omitted. Replay in the same epoch reuses its selection without duplicate injection.

Correction: user edits or says “forget that preference” → resolve an exact record or ask when ambiguous → CAS commit → increment capture generation/suppression fence → remove future selection → show receipt. Correction invalidates queued selections; requests already sent cannot be retroactively erased. The UI exposes that boundary and subsequent requests use the corrected generation.

## Freshness and conflict handling

File modification does not erase preferences or unrelated notes. Source-backed repository observations become changed; ranking may retain them as leads for a bounded revalidation query. Current code/configuration wins over memory. Stale observations cannot establish API shape, architecture, build command validity or acceptance. Revalidation reads current sources before relying on an observation; failure omits factual use and reports uncertainty when material.

Source-independent explicit preferences remain applicable until user correction, declared expiry or conflicting user instruction. A new task's explicit request wins without overwriting the stored preference unless the user asks to remember that change. Two incompatible explicit records form a conflict set; ordinary operation proceeds using current task instructions, and durable conflict resolution is nonblocking unless the task actually depends on it.

Ranking decay reduces retrieval priority of unused advisory notes. Retrieval count does not increase factual confidence. Confidence cannot convert unverified content to current fact. No repeated “should I update memory?” prompt occurs merely because files changed; background revalidation and the inspectable indicator handle ordinary drift.

## Child scope and privacy

Children receive only explicitly selected bounded ContextPacket sources. No implicit parent/sibling transcript, global inference or profile-memory inheritance occurs. Profile-private memory is keyed by stable AgentProfileId within its parent user/project scope; default sharing is none. Parent/profile deletion never silently reassigns records. External injection requires policy, Run consent, adapter capability and egress scope intersection.

Child observations may be advisory only within their admitted project/private scope when the capture policy explicitly permits it; otherwise they are candidates. Children cannot fabricate user intent, promote to reviewed/user-directed admission, widen scope, purge parent records or turn messages into evidence. Disabling memory cancels capture jobs and fences late writes by generation; no pending job may commit after the disable fence.

Memory remains local. Export is explicit and scope-filtered with metadata and best-effort secret filtering. No remote index, embedding provider or synchronization is required. User-approved model requests can include selected memory under their data-egress policy; “local storage” does not mean the selected prompt remains on-device. Known credentials are excluded; imperfect detection of arbitrary secrets is disclosed without claiming complete redaction.

## Product interaction

`/memory` opens a searchable scoped list with mode, origin, age and source filters. Actions: Inspect, Edit, Forget, Dismiss inferred pattern, Review candidate, Export, Purge scope. `/forget <reference>` shares the same deletion path. Keyboard activation and accessible text equivalents accompany every pointer action; IDs/digests/outbox details remain expandable. Forget requires no extra confirmation for one selected record; bulk purge previews affected scope/count and requires explicit destructive confirmation.

Saved/recalled indicators are passive and batched. No per-record animation or toast spam. Motion follows shared reduced-motion and idle-rendering contracts. Memory panel selection and drafts survive refresh; revision conflicts show reload/compare instead of silently replacing edits. Empty, disabled, unavailable, indexing, stale and audit-pending states have distinct language. Advisory notes say “Observed,” explicit notes say “You asked to remember,” and reviewed notes identify their source.

## Resource bounds and settings

Finite defaults: 8 KiB UTF-8 content per record; 2,000 records and 16 MiB content per scope; 128 queued observations; 20 retrieved records, 16 KiB rendered memory and 2,048 tokens, with the first reached bound controlling selection. Advisory expiry is 90 days unless configured; explicit preferences have no automatic expiry. Automatic extraction has at most one background job per project and a separately reserved budget; saturation coalesces source references and reports coverage gaps rather than dropping evidence silently. Candidate retention is 30 days. FTS pages use bounded cursors.

Settings: mode ambient|explicit|off, retrieval_enabled, project_capture_enabled, profile_capture/sharing, excluded_paths/kinds, max_record_bytes, scope quotas, retrieval limits, advisory/candidate retention, extraction budget, allowed model route. Project settings may narrow capture/egress, never enable global sharing or widen managed authority. Turning retrieval off differs from disabling capture; the panel labels both. Off disables both. Settings changes invalidate future epochs and fence late jobs.

## Failure and recovery

| Failure | Behavior |
|---|---|
| Corrupt/newer SQLite | Preserve bytes, offer recovery, never replace with an empty store |
| Crash before commit | No partial record/event/outbox; retry stable request ID |
| Crash after commit | Resolve durable receipt; retry outbox without another save |
| Index lag/corruption | Report coverage, query canonical bounded records or rebuild; no complete-miss claim |
| Source changed/unavailable | Revalidate asynchronously; factual use blocked until supported |
| Concurrent edit/delete | CAS conflict or identical deletion receipt |
| Disk/quota exhausted | Existing records readable; refuse writes with action guidance |
| Disable/forget races with capture | Generation and suppression fence prevent late resurrection |
| Candidate extracted from injected tool/web text | Untrusted origin; never user-directed; no instruction promotion |
| Lost remote provider response | Extraction may fail independently; foreground work continues with recorded omission |
| Backup restore after deletion | Apply deletion ledger or explicit user-authorized restore choice; no promise to erase disconnected exports/backups |
| External worker hidden context | Report unknown; no unproved isolation or zero-cost assumption |

Deletion removes active content and derived indexes; SQLite/WAL cleanup and backups have explicit retention. Logical deletion is not a guarantee of forensic secure erasure. Minimal suppression/tombstone digests persist locally to prevent resurrection; their retention and purge behavior are inspectable. Audit stores retain only redacted receipts. Previously exported files are outside automatic deletion scope.

## Acceptance

Verify direct remember has zero redundant approval; ambiguous scope is resolved; advisory automatic capture never claims user confirmation; explicit new instruction defeats conflicting memory; restricted assertions cannot become authority; known-secret canaries are excluded. Test all admission/state paths, exact revisions, SQLite/outbox crash boundaries, duplicate request IDs, multi-process writes, index rebuild, quotas and source/dirty-buffer changes.

Verify disable/forget against in-flight extraction and epoch construction; suppression survives restart and restore; local-to-model egress is disclosed; exports remain scoped; moved/linked projects and worktrees use one identity. Test child namespaces, external capability uncertainty, prompt injection and fabricated provenance. Test keyboard Edit/Forget/Undo, screen-reader labels, passive indication, empty/error states and no idle animation work.

Compare repeated coding tasks with memory off, explicit and ambient modes. Measure task correctness, repeated-correction count, harmful stale application, time to identify/correct a wrong note, foreground latency, context cost and user confidence. Fewer tokens alone is insufficient. User research must include both users who prefer automatic memory and those who prefer explicit control.

## Schema validation and request envelopes

All memory API envelopes are versioned, reject unknown fields, enforce limits before allocation and carry a stable request ID. IDs use typed opaque UUIDv7 values; revisions, generations and event sequences are unsigned 64-bit integers. Content digests are `{algorithm: "blake3", hex: 64 lowercase hexadecimal characters}`. Timestamps are RFC3339 UTC values; ranking uses a query-pinned timestamp so the same snapshot yields the same ordering. IDs and provenance fields are server-assigned. Model input cannot assign admission principal, origin verification, sequence or state.

```text
MemoryScopeV2 =
 User { user_scope_id: UserScopeId, agent_profile_id?: AgentProfileId }
 | Project { user_scope_id: UserScopeId, project_id: ProjectId,
             agent_profile_id?: AgentProfileId }

MemoryQueryV2 {
 schema_version: 2, request_id: UUIDv7, scope: MemoryScopeV2,
 query: UTF8[0..4096 bytes], kinds: Set<MemoryKind>[1..6],
 workspace_id?: WorkspaceId, source_view?: SourceView,
 context_epoch: ContextEpochId, policy_digest: Digest,
 expected_capture_generation: u64,
 bounds: { max_records: u32, max_bytes: u32, max_tokens: u32 },
 cursor?: OpaqueCursor
}

RememberRequestV2 {
 schema_version: 2, request_id: UUIDv7, scope: MemoryScopeV2,
 content: UTF8[1..8192 bytes], kind: MemoryKind,
 expected_scope_revision: u64, expected_capture_generation: u64,
 user_intent_ref: AdmittedInputRef, expires_at?: Timestamp
}

CaptureRequestV2 {
 schema_version: 2, request_id: UUIDv7, scope: ProjectScopeV2,
 expected_capture_generation: u64, policy_digest: Digest,
 observations: ObservationV2[1..32]
}
ObservationV2 {
 content: UTF8[1..8192 bytes],
 kind: preference | feedback | repo_observation,
 source_refs: MemorySourceRef[1..16], applicability_key?: UTF8[1..256 bytes],
 extraction_receipt_ref?: ReceiptRef, confidence_band?: low | medium | high
}

MemoryMutationV2 {
 schema_version: 2, request_id: UUIDv7, scope: MemoryScopeV2,
 memory_id: MemoryId, expected_revision: u64,
 expected_capture_generation: u64,
 operation: Edit { content: UTF8[1..8192 bytes], user_intent_ref: AdmittedInputRef }
          | Forget { user_intent_ref: AdmittedInputRef }
          | Dismiss { user_intent_ref: AdmittedInputRef }
          | Review { choice: approve | reject, user_intent_ref: AdmittedInputRef }
}

MemorySelectionV2 {
 memory_id: MemoryId, revision: u64, content_digest: Digest,
 admission: AdmissionClass, freshness: Freshness,
 excerpt: UTF8[0..8192 bytes], source_refs: MemorySourceRef[0..16],
 use: preference_hint | confirmed_preference | revalidation_lead | reviewed_note,
 scope: MemoryScopeV2, selection_reason: ReasonCode
}

MemoryPageV2 {
 schema_version: 2, snapshot_seq: u64, capture_generation: u64,
 records: MemorySelectionV2[0..20], next_cursor?: OpaqueCursor,
 indexed_seq: u64, coverage: complete | partial | rebuilding,
 omitted: { reason: ReasonCode, count: u32 }[0..32],
 rendered_bytes: u32, token_count: u32, tokenizer_id: UTF8[1..128 bytes]
}
```

User scope supports preferences and workflow habits, not repository facts copied into a global namespace. Direct Thread/Run scope comes from admitted identity; a caller-supplied project ID is checked against that identity. Source-reference presence alone does not authenticate a user intent. AdmittedInputRef must resolve to a committed user interaction authorizing the operation; peer messages, model output and repository text cannot satisfy it.

`MemoryRecordV2` content has at most 8,192 UTF-8 bytes, at most 16 source references and one source namespace. `origin`, `admission` and `state` must obey the admission table. A `user_directed` record requires validated user_intent_ref; `reviewed` requires a review principal and exact candidate revision; `advisory_auto` requires a project scope, permitted kind and capture-policy digest. Candidate decisions never have automatic active admission. Deleted records have no recoverable content field or FTS row. Unknown enum values fail with `MEMORY_SCHEMA_UNSUPPORTED`; they are never coerced into an active record.

Public errors distinguish `MEMORY_SCOPE_MISMATCH`, `MEMORY_POLICY_DENIED`, `MEMORY_INTENT_REQUIRED`, `MEMORY_REVISION_CONFLICT`, `MEMORY_CAPTURE_FENCED`, `MEMORY_CAPACITY_REACHED`, `MEMORY_SOURCE_UNVERIFIED`, `MEMORY_RECOVERY_REQUIRED`, `MEMORY_SCHEMA_UNSUPPORTED` and `MEMORY_NOT_FOUND`. Errors include a bounded user explanation and recovery action without another scope's content. Reusing a request ID with different normalized arguments returns `MEMORY_REQUEST_CONFLICT`. Scope purge uses a separate envelope with an exact preview revision and admitted destructive confirmation; per-record Forget cannot authorize a purge.

## Deletion fences and retention

Every scope has a monotonically increasing capture_generation and scope_revision. Disable, Forget, Dismiss and Purge update the generation in the same transaction as their state change. Extractors and context builders validate the expected generation at commit or request dispatch. An existing ContextEpoch whose selected record was deleted is invalidated before a new request is sent; a previously dispatched request retains its original audit receipt and cannot be recalled.

Forget deletes the selected record and adds a content-digest suppression marker. Dismiss additionally suppresses its reviewed applicability key. Suppression markers retain no plaintext and do not grant authority. Automatic capture with that digest/key is rejected until an explicit user-directed save clears suppression for the exact intended item. User-directed saves do not silently clear unrelated suppression. Scope purge is the only bulk deletion path and creates a scope-generation restore fence.

Suppression/tombstone retention is indefinite by default with inspectable storage accounting. Compacting tombstones requires either a retained scope restore fence covering all older backups or an explicit decision to retire those backups; restoration without either requires a user-visible resurrection choice. Existing external exports and disconnected backups cannot be erased by this store. Accepted explicit record revisions remain until disclosed retention/purge; advisory revisions expire after 90 days and candidates after 30 days. Events retain redacted identifiers, operation and digests rather than old deleted content; the same lifecycle removes content from WAL/index projections according to the storage cleanup contract.
