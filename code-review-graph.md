# Code Review Graph: repository intelligence and PR risk analysis

> INTERNAL RESEARCH — reviewed 2026-09-27. Snapshot: main, commit `6b12d11625cbec3b6773e076cb3d136464fa90e5`; latest release noted is v2.3.9 (2026-09-18). Focused audit of schema, indexing and integrations.

## HLD

Code Review Graph builds a local structural code graph from repository source using Tree-sitter-oriented parsers, stores it in SQLite, and exposes repository/impact context through CLI, MCP, CI and editor surfaces. Its job is to answer code-navigation and change-risk questions, not to own coding-agent execution or task state.

## LLD and graph schema

The documented schema is versioned (v13 in the reviewed source). Node families include File, Class, Function, Test, Type, Endpoint, Scheduler, ConfigProperty and Event. Edge families include CALLS, IMPORTS_FROM, INHERITS, IMPLEMENTS, CONTAINS, TESTED_BY, REFERENCES, DEPENDS_ON, INJECTS, CONSUMES, PRODUCES, TEMPORAL_STUB, DEPENDS_ON_CONFIG, HANDLES, TRIGGERS and PUBLISHES. The graph and derived indexes live under `.code-review-graph/`, including a SQLite graph database.

Indexing hashes files and updates incrementally; post-processing derives additional flow/community/full-text or optional embedding structures. A watcher can keep the index fresh. Query interfaces offer symbol neighborhoods, call paths, impact/blast-radius slices and review context. PR mode compares changed files and combines graph context into a risk/review report; GitHub Action and VS Code integrations wrap these services.

## Flows

Repository files → language parser → symbols/references/edges → incremental SQLite write → post-processing/index refresh → CLI/MCP/editor query. PR flow: Git diff → changed-node mapping → affected callers/tests/config/dataflow neighborhoods → risk/context report → reviewer or coding agent consumes evidence. Incremental refresh is essential: graph output is only as trustworthy as the indexed revision and parser coverage.

## Reliability and limits

- Static analysis is incomplete where language support, dynamic dispatch, reflection, generated code or framework conventions exceed parser rules. Inferred edges must be labeled as inferred.
- Watcher delay/failure can leave stale results; every response should identify index revision and refresh status.
- Project benchmark claims are not independent. The v2.3.6 report says 82× median versus its realistic grep/read baseline, with a broad 38–528× range; do not generalize without reproducing both workload and baseline.
- Issue #812 reports possible orphan nodes during an interrupted update; treat as a project-reported concern, not a reproduced defect. A prior rename/stale-node issue was addressed before the reviewed release.
- PR risk scores are triage signals, not proof of correctness or security.

## Relevance to HorizonCode

Potential repository-intelligence adapter: provide evidence slices with symbol IDs, source locations, graph revision and confidence/provenance. Keep lexical search and direct source reads available as independent fallback. Evaluate recall and stale-index detection against HorizonCode's Rust code before depending on the graph for planning or verification.

## Primary references

[Schema](https://github.com/tirth8205/code-review-graph/blob/main/docs/schema.md) · [Usage](https://github.com/tirth8205/code-review-graph/blob/main/docs/USAGE.md) · [VS Code extension](https://github.com/tirth8205/code-review-graph/blob/main/code-review-graph-vscode/README.md) · [Releases](https://github.com/tirth8205/code-review-graph/releases) · [Issue #812](https://github.com/tirth8205/code-review-graph/issues/812)
