# Code intelligence

## Purpose and ownership

CMP-repo-intel owns repository manifests, parsers, symbol and relationship indexes, LSP/SCIP coordination, diagnostics and impact analysis. CMP-workspace supplies exact revision identity. CMP-context owns ranking and prompt budgets; UI and tools consume bounded results rather than create indexes.

## Public contracts and data model

```text
WorkspaceRevisionV1 {
  workspace_id, provider_id, provider_version, committed_revision,
  dirty_manifest_digest, editor_buffer_digest?, generation
}
IntelligenceQueryV1 {
  query_id, operation, workspace_revision, scope, symbol_or_pattern?,
  result_limit, byte_limit, deadline_budget_ms, cancellation_ref
}
IntelligenceResultV1 {
  query_id, index_generation, query_revision, parser_adapter_version,
  freshness: CURRENT | STALE | UNAVAILABLE,
  coverage: COMPLETE | PARTIAL | UNSUPPORTED,
  authority: SEMANTIC | LEXICAL, source_ranges[], bounded_payload,
  next_cursor?, limitations[], refresh_ref?
}
CodeIntelligenceProvider
  index(workspace_revision) -> IndexGeneration
  definition(symbol, query) -> SymbolResults
  references(symbol, query) -> ReferenceResults
  diagnostics(scope, query) -> DiagnosticSet
  call_graph(symbol, query) -> CallGraph
  impact(changeset, query) -> ImpactSet
```

Manifest/path completion, hover, document/workspace symbols, implementations and call hierarchy share this owner and report unsupported methods explicitly. Unsaved editor buffers are distinct from the dirty filesystem manifest. A combined digest is permitted only with versioned encoding of both sources; HEAD alone is insufficient.

## Architecture and flows

Lazy incremental indexing runs outside model dispatch with bounded workers, deadlines and cancellation. Index → query → exact revision/freshness validation → bounded context/UI result is the single flow. Mutation, buffer change, parser upgrade or server restart invalidates affected generations before a stale result can authorize an edit. Multi-root queries preserve each root's provider-qualified binding.

Tree-sitter, LSP and SCIP are adapters. LSP processes use the normal host/confinement/effect path and declared roots/egress; server content cannot grant trust. Lexical fallback stays labeled lexical and cannot claim exact semantic references. Impact analysis is advisory and cannot replace independent verification.

## Failure, security and bounds

Stale/partial results cannot silently become authoritative current facts. Timeout/crash/malformed response returns a typed failure or partial coverage with refresh action. Missing operations never become a fabricated empty set. Parsing, file walks and payloads obey finite result/byte/deadline limits and exclusions; background indexing yields to input, streaming and cancellation. Egress requires explicit authorization.

## Acceptance

Cover dirty files and unsaved buffers separately, incremental invalidation, multi-root identity, parser/server restart, timeout, malformed messages, cancellation, stale fallback labels, privacy/egress and context bounds. Bind evidence to exact workspace revision, build and toolchain.
