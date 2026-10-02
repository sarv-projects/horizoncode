# Code intelligence

## Purpose and ownership

`CMP-repo-intel` is the single owner of repository manifests, parsers, syntax and
semantic indexes, lexical retrieval, LSP/SCIP coordination, diagnostics, and impact
analysis. `CMP-workspace` supplies the exact source view and workspace revision.
`CMP-context` ranks bounded results for a model request; `CMP-tools` exposes guarded,
model-facing operations; user surfaces render owner-produced status and results. None
of these consumers creates a second index or treats an index result as permission,
canonical repository truth, or verification evidence.

The query and manifest interfaces below are HorizonCode contracts. The index process
is an implementation detail behind this owner; swapping its storage or transport does
not create a new owner.

## Public contracts and data model

```text
WorkspaceRevisionV1 {
  workspace_id, provider_id, provider_version, root_identity,
  base_revision, dirty_manifest_digest, editor_buffer_digest?, generation
}
FileManifestEntryV1 {
  workspace_id, relative_path, file_identity?, content_digest?,
  byte_length?, source_view, language?, parser_adapter_version?,
  state: PRESENT | DELETED
  # PRESENT requires content_digest and byte_length; DELETED is a tombstone.
}
IndexGenerationV1 {
  workspace_id, generation, base_generation?, overlay_generation?,
  workspace_revision, manifest_digest, parser_set_digest, grammar_set_digest,
  read_scope_digest, policy_snapshot_digest, schema_version,
  lexical_backend_id?, embedding_model_id?, embedding_model_version?,
  embedding_model_digest?, embedding_dimensions?, state: BUILDING | READY | PARTIAL |
          STALE | FAILED, created_at
}
IntelligenceQueryV1 {
  query_id, operation, workspace_revision, index_generation?, scope,
  symbol_or_pattern?, result_limit, byte_limit, deadline_budget_ms,
  cancellation_ref
}
IntelligenceResultV1 {
  query_id, workspace_id, query_revision, index_generation?,
  source_method: DIRECT | LEXICAL | TREE_SITTER | LSP | SCIP | EMBEDDING,
  authority: EXACT | LEXICAL | SYNTACTIC | SEMANTIC | HEURISTIC,
  freshness: CURRENT | STALE | UNAVAILABLE,
  coverage: COMPLETE | PARTIAL | UNSUPPORTED,
  source_ranges: IntelligenceSourceRefV1[], bounded_payload, next_cursor?, limitations[], refresh_ref?
}
IntelligenceSourceRefV1 {
  workspace_id, relative_path, source_view: DISK | EDITOR_BUFFER,
  source_revision, content_digest, range: {start_byte, end_byte},
  index_generation?, source_method, authority, freshness, coverage, limitations[]
}
CodeIntelligenceProvider {
  index(workspace_revision) -> IndexGenerationV1
  definition(symbol, query) -> IntelligenceResultV1
  references(symbol, query) -> IntelligenceResultV1
  diagnostics(scope, query) -> IntelligenceResultV1
  call_graph(symbol, query) -> IntelligenceResultV1
  impact(changeset, query) -> IntelligenceResultV1
}
```

`EXACT` authority means an observed direct source/path fact on the stated revision;
it does not imply compiler resolution, permission or verification.

Manifest/path completion, hover, document/workspace symbols, implementations,
references, diagnostics, call hierarchy, and lexical search share this owner and report
unsupported methods explicitly. Unsaved editor buffers are a distinct source view,
not silently merged with dirty on-disk files. A combined digest is permitted only
with a versioned encoding of both sources; the base commit alone is insufficient.

`FileManifestEntryV1` is derived metadata for files the current workspace policy
allows the indexer to inspect. `content_digest` uses the pinned BLAKE3 implementation
and encoding version for identity and change validation. The index database and all
search structures are rebuildable derived state; they never replace the workspace,
source files, effect journal, or event log as truth. A digest does not prove that a
file is authorized to be read.

## Architecture and service lifecycle

The repository-index runtime is a Rust child process, logically named `horizon-indexd`,
supervised by the existing local execution-host mechanism and requested through
`CMP-repo-intel`. It runs the private index-worker mode of the signed `hzcode` binary;
it is not a second distributed executable. Packaging, digest checks, upgrade fencing,
and platform refusal are owned by [Distribution and updates](../integrations/DISTRIBUTION-AND-UPDATES.md#supervised-helper-packaging).
It communicates with the parent over a private, OS-authenticated local IPC channel
with a versioned, length-bounded message protocol. The child receives only the
workspace roots, a revocable read-scope snapshot derived from Guard and the workspace
binding, resource budget, and operations required for indexing;
it receives no Guard decision authority, approval channel, controller credentials,
secret values, or unrestricted network access. It cannot mutate workspace files.

The interactive surface becomes usable before optional repository indexing starts.
After UI readiness, `CMP-repo-intel` may start or attach to the supervised helper
asynchronously. This is a child owned by the live HorizonCode supervisor, not a
public listener or detached daemon; startup does not bind a network port. If process
supervision, private IPC, or required path confinement is unavailable on a platform,
indexing reports unavailable and consumers use permitted direct reads or lexical
fallbacks. UI readiness and control/cancellation never wait for initial scanning.

Private IPC frames carry protocol version, request ID, workspace binding, generation,
operation, and bounded payload length. The parent rejects unknown versions, oversized
frames, duplicate/stale request IDs, out-of-scope workspace bindings, and late replies.
The child checks cancellation and its resource budget at bounded work boundaries.
Control and cancellation traffic cannot sit behind bulk scan payloads. A helper crash
invalidates its in-memory handles; persistent generations are reopened only after
schema, digest, policy, and workspace-revision checks. Restart never upgrades stale
data to current.

## Index storage and generation publication

The storage design uses SQLite for bounded, policy-permitted manifest metadata,
generation metadata, pins, migration state, and job recovery. Full-text search is
behind a small replaceable embedded-backend adapter. A choice such as Tantivy is a
benchmark candidate, not a measured or mandatory selection. The metadata schema does
not depend on a particular full-text engine. Optional semantic embeddings use a
separate replaceable backend and are disabled by default.

Each workspace generation is a coherent snapshot of its manifest, parser outputs,
syntax relationships, lexical backend generation, and optional enrichment identities.
A new generation is staged separately from the last published one. The owner
publishes its generation pointer only after all required components are complete and
cross-store generation/digest checks pass. For a replaceable full-text backend,
publication binds the exact backend generation and manifest digest in the SQLite
commit; queries pin and read that pair. A crash before pointer publication leaves the
old generation usable if its source revision is still current and makes staged data
reclaimable. A crash or mismatch after publication yields a typed stale/partial state,
never a mixed generation. Backend migration either builds a replacement generation
side by side and atomically switches the owner pointer or discards it and rebuilds;
there is no in-place interpretation of incompatible bytes.

Generations are scoped to the effective read-scope and policy snapshot that admitted
their file contents. A query revalidates the current policy before returning any
record; policy narrowing fences in-flight queries and makes newly denied records
inaccessible immediately. A generation built under a broader scope cannot be attached
to a narrower binding unless the owner proves the indexed manifest is a permitted
subset; otherwise the owner purges or rebuilds the affected generation. A query pins a
generation for its bounded lifetime. Generation pins are released on completion,
cancellation, client disconnect, or supervisor cleanup. Retention and
reclamation are bounded; active query/task/worktree pins prevent deletion of their
referenced generation. The owner reports exhausted storage or quota as a typed health
state rather than pruning a generation still needed for recovery.

## Change detection and incremental indexing

Change hints are processed in this order, with the digest as the final validation:

1. A completed HorizonCode mutation/effect receipt with exact paths, base identity,
   and resulting content identities.
2. An exact editor-buffer delta with document version and buffer identity.
3. A Git revision-transition hint from the workspace provider.
4. A filesystem watcher event marking a path or subtree dirty.
5. Bounded periodic or post-restart reconciliation.
6. A fresh BLAKE3 content digest read through the authorized workspace path.

The first five inputs are hints; none substitutes for checking current content and
workspace identity. A watcher overflow, dropped event, unknown rename, or uncertain
filesystem state marks the affected scope stale and schedules bounded reconciliation.
Until reconciliation validates a new generation, queries report freshness
`STALE` or `UNAVAILABLE` and coverage `PARTIAL` or `UNSUPPORTED` as applicable and may use a permitted direct/lexical fallback clearly labeled
with its source. They never present a stale result as current.

For a created file, parse and index only that file. For a modified file, use
Tree-sitter incremental edit operations only when the exact old/new edit ranges and
matching parser version are available; otherwise reparse the changed file. For a
deleted file, tombstone its manifest entry and remove its contributions from the next
generation. For a rename, reuse content-derived parsing only when the verified digest
and parser identity match, then rebuild path-sensitive records and references. A
single-file change does not trigger a repository-wide parse. Full scans are limited
to initial indexing, bounded reconciliation, incompatible migration, or verified
rebuild requests.

Tree-sitter supplies syntactic structure and approximate relationships. LSP/SCIP
supplies separately labeled semantic operations when supported. Lexical matches are
labeled lexical. Embedding candidates have method `EMBEDDING` and authority
`HEURISTIC`; vector similarity never proves a semantic reference. No layer upgrades an approximate edge into a compiler-resolved
reference. Full ASTs are not persisted as the normal index representation; bounded
parse outputs include definitions, signatures, imports/exports, scopes, and useful
syntax relationships, with an LRU hot-AST cache for active and recently queried
files.

## Query APIs and context projection

The internal provider operations remain fine-grained. The preferred model-facing
surface groups repository work into four bounded operations, registered and permission
filtered through the single tool plane in [`CMP-tools`](../core/TOOLS.md). Schemas
carry bounded intent and output limits; workspace, principal, policy, revision, and
index generation come from validated `ToolContext` and owner state, not model-supplied
paths or authority fields.

| Operation | Bounded request | Result contract |
|---|---|---|
| `repo_query` | One or more typed queries (`TEXT`, `SYMBOL`, `DEFINITION`, `REFERENCES`, `DIAGNOSTICS`, or supported mixed query); optional authorized relative scopes; result and byte ceilings. | Ordered, deduplicated candidates with exact source ranges and per-result method, authority, freshness, coverage, and provenance. A batch shares one validated workspace/generation snapshot. |
| `repo_context` | A controller-approved managed-task reference or an admitted direct-turn intent reference, plus bounded task hints and a context byte/token ceiling. | A `TaskPackageV1` projection with likely source files/symbols/tests, relationships, diagnostics, and explicit omissions; context owner decides what enters the model packet. A direct turn never fabricates a managed Task. |
| `repo_impact` | A revision-bound changeset reference or bounded changed-file/symbol set from the current workspace. | Likely callers, implementations, interfaces, config, and tests, with source method and coverage; advisory only. |
| `repo_expand` | One short-lived retrieval handle and a bounded expansion request. | Exact additional ranges or typed stale/expired/unavailable status; the handle is revalidated against the active context and permissions. |

No operation accepts raw absolute paths as authority. Relative scope is resolved under
the bound workspace and then rechecked by the ordinary Guard/Sandbox path. Every
result is capped by schema limits, and cursors are bound to the same query, workspace,
generation, and authorization snapshot.

These operations do not replace deterministic `read`, `list`, `glob`, or `grep`.
All operations use finite schema limits, result/byte caps, deadlines, cancellation,
and the same Guard, sandbox, workspace, audit, budget, and tool-result paths. A
model-facing tool cannot ask the indexer for data that the same principal is not
currently authorized to read. Search metadata is untrusted data and cannot supply
instructions or permission.

`TaskPackageV1` is a bounded, ephemeral context projection, not a durable store or a
second child packet. It is assembled by `CMP-context` from the approved task and a
pinned `WorkspaceRevisionV1`/`IndexGenerationV1`, then included as selected content
inside the existing [`ContextPacketV1`](../core/CONTEXT.md#sub-agent-and-worktree-sharding)
when delegation requires it. The value may contain likely files and symbols, relevant
tests, dependency neighborhood, current diagnostics, recent workspace changes,
useful exact ranges, retrieval handles, provenance, and explicit omissions. Every
handle is scoped to workspace, index generation, source identity, byte budget, and
expiry; it cannot be replayed against another worktree or a newer generation.

Repo-context assembly is deterministic and budgeted. The index itself and complete
repository database never enter the model context. Results carry workspace/provider
identity, base revision, dirty-manifest and buffer digests, index generation,
source method/authority, coverage, freshness, and limitations. `repo_impact` and test
candidates are advisory; only the verifier and controller can produce or accept
completion evidence.

## Resource scheduling and responsiveness

The single `CMP-repo-intel` `IndexResourceGovernor` is subordinate to HorizonCode
control and interactive work. It enforces bounded queues, per-workspace fairness,
cancellation, CPU/RAM/disk/worker limits, and explicit overload status; this is not a
second application task scheduler. Priority lanes are:

| Lane | Work |
|---|---|
| P0 | Control, cancellation, health/fencing, and generation invalidation |
| P1 | Interactive repository queries and retrieval-handle expansion |
| P2 | Active-file/editor-buffer and just-written-file updates |
| P3 | The active task's relevant repository neighborhood |
| P4 | Other dirty-file reconciliation |
| P5 | Initial repository scan |
| P6 | Optional semantic enrichment and embeddings |

Lower-priority work yields when control or interactive work needs capacity. A user
actively typing or streaming does not cause interactive query capacity to be consumed
by an initial scan or embedding job; P6 enrichment pauses when required to preserve
input, streaming, cancel, and approval responsiveness. Worker count, bytes per request, queue depth,
CPU/RAM/disk ceilings, per-file parse time, job deadlines, and cancellation intervals
are schema-bound finite resource limits. Overload is observable and degrades optional
index coverage before it degrades input, cancel, approval, or stream responsiveness.

## Failure, security, migration, and health

Indexing is not an alternate filesystem authority. Before reading a path, the owner
must apply the current workspace scope, Guard read policy, Sandbox reach, symlink and
root rules, and exclusions. Denied or protected files are neither read nor persisted
in manifest, parser, lexical, or semantic stores. A narrowed permission snapshot
immediately fences new reads and queries and invalidates/purges inaccessible cached
records before they can be returned; old index contents cannot bypass later `read`
denial. Path names, file size, digests, and inferred metadata can themselves be
sensitive, so they are omitted for denied files. Secret detection is not complete and
must not be represented as a guarantee.

Defaults skip `.git`, configured generated/vendor/dependency trees, binaries,
symlinks, oversized files, unsupported file types, and user- or policy-denied paths.
The exact default patterns and override precedence are versioned configuration in
`CMP-config`. A user exclusion cannot weaken a mandatory security exclusion. Skipped
files are not recorded as manifest entries; aggregate exclusion counts may be reported
without revealing denied names. A skipped file can be inspected only through the
ordinary authorized file-read path. Excluding a file does not prevent lexical search
in other authorized files.

Parser and native grammar assets are executable supply-chain inputs. Pin parser and
grammar versions, digests, source/provenance, and compatibility in the index schema.
Do not download and load arbitrary grammar binaries dynamically. Grammar or parser
changes create a new generation and require bounded rebuild/migration. Store explicit
schema, parser-adapter, grammar-set, lexical-backend, and (when enabled) embedding
model/version/digest/dimension identities. Never combine vector rows from different
model identities or reinterpret stale schema bytes. On incompatibility, build a fresh
generation safely or report unavailable and fall back to allowed lexical/direct
operations.

Health is surfaced through the existing `/doctor` and context-source inspection
surfaces, not a new slash-command family. Report child-process/IPC state, workspace
coverage, current generation/revision, stale/partial status, aggregate exclusion
counts without revealing denied names, queue saturation, last reconciliation,
schema/backend versions, storage use, and repair/rebuild eligibility. Rebuild is an explicit,
bounded owner action; inspection itself is read-only. Missing parsers, LSP/SCIP,
watchers, storage, or permissions produce typed unsupported/unavailable states, not
empty successful results.

## Acceptance

Acceptance for these code-intelligence contracts is specified by `ACC-REPO-INDEX-01`,
`ACC-REPO-OVERLAY-01`, `ACC-REPO-TOOLS-01`, and existing `ACC-REPO-LSP-01` /
`ACC-REPO-01` in the [acceptance matrix](../acceptance/ACCEPTANCE-MATRIX.md).
Evidence must bind the exact code/build, schema/parser/grammar/backend identities,
workspace revision, policy and resource configuration, and test environment.
Cover initial and incremental indexing; exact versus fallback delta handling;
manifest/content-digest validation; fresh/stale generation transitions; crash and
cross-store publication recovery; watcher overflow and bounded reconciliation;
parser/backend/schema migration; cancellation and overload fairness; excluded,
denied, symlink, secret-pattern, generated, vendor, binary and oversized files;
permission narrowing after indexing; query freshness/provenance/cursors; multiple
roots; unavailable LSP/SCIP; retrieval-handle expiry; TaskPackage bounds; and
non-blocking interaction during large-repository indexing. Test multiple repository
sizes defined by the sole [performance contract](../contracts/PERFORMANCE.md).
