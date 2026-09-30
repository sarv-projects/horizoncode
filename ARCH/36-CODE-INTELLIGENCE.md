# 36 — Code Intelligence Plane (`CMP-repo-intel`)

**Status:** proposed target LLD. A repository-intelligence component is named in
`ARCH/03`, but the complete revision-bound symbol graph and provider contract below
are not thereby implemented.

## Ownership

`CMP-repo-intel` owns parsing/index generations, symbol and relationship queries,
LSP/SCIP coordination, diagnostics, and change-impact analysis. `CMP-context` owns
prompt selection, token budgets, and context epochs; it consumes bounded, sourced
results from repo-intel. `CMP-workspace` supplies the exact workspace identity and
revision. UI and workers do not create parallel indexes.

## Port

```text
WorkspaceRevision { workspace_id, committed_revision, dirty_buffer_digest, generation }

CodeIntelligenceProvider
  index(workspace_revision) -> IndexGeneration
  definition(symbol, workspace_revision) -> SymbolResults
  references(symbol, workspace_revision) -> ReferenceResults
  diagnostics(scope, workspace_revision) -> DiagnosticSet
  call_graph(symbol, workspace_revision) -> CallGraph
  impact(changeset, workspace_revision) -> ImpactSet
```

Every result includes workspace/revision, dirty-buffer digest when applicable,
provider/parser version, freshness, source ranges, and typed completeness. Unsupported
language/server/index operations are explicit. Stale results are rejected for
authoritative edits and verification; callers may use labeled lexical/read fallback.
Indexing is lazy, incremental, bounded, cancellable, and off the model-dispatch path
(`REQ-CTX-012`, `REQ-REPO-001/002/004`).

## Adapter and failure rules

Tree-sitter, LSP, SCIP, and any future semantic index are adapters behind this port.
Repository content, server responses, and symbols are untrusted data and cannot grant
tool permission. A server restart, workspace mutation, buffer edit, parser upgrade, or
revision change invalidates affected generations. Queries return `STALE` or
`UNAVAILABLE` and schedule/recommend refresh; they never silently relabel old results
as current.

Acceptance should cover incremental invalidation, dirty buffers, multi-root identity,
server timeout/crash, malformed results, cancellation, stale fallback, privacy/egress,
and context-budget bounds. The acceptance record must bind exact revision and toolchain;
this document claims no pass.

## Final intelligence schema and flow completion

WorkspaceRevision binds committed snapshot, dirty filesystem manifest, and optional
editor-buffer digest separately, plus provider identity and generation. A combined
`dirty_buffer_digest` must use a versioned encoding that covers both dirty files and
unsaved buffers; HEAD alone is insufficient. Results include index generation,
query revision, coverage (complete/partial), authority (semantic/lexical fallback),
source ranges and adapter/parser version, with finite result/byte/deadline bounds.

The same owner supplies file manifests/path suggestions, definition/reference/hover,
document/workspace symbols, implementations and call hierarchy where supported.
Unsupported methods return explicit results, not fabricated empty sets. LSP workers
are launched through the host/confinement/effect path with declared roots and egress;
SCIP/parser artifacts never grant trust. Index → query → freshness check → bounded
context/UI result is the sole flow; change events invalidate generations before a
result can authorize an edit. Impact analysis is advisory and cannot replace the
independent verifier. Multi-root queries preserve each root's exact binding.

## Interaction and integration reconciliation (2026-09-30)

WorkspaceRevision binds provider ID + committed revision + dirty_manifest_digest + optional editor_buffer_digest; unsaved buffers are never the filesystem dirty digest. Fast lexical lookup remains labeled lexical; exact reference claims require semantic freshness evidence.

Detailed shared contracts: [ARCH/37](37-INTERACTION-AND-FAST-PATH.md) and [ARCH/38](38-LITEPSM-INTEGRATION.md). Status remains proposed; see TODO AX-401..410.
