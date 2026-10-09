# `indexd` library slice

This crate is a bounded, in-memory lexical indexing library. It is **not** an
`hz-indexd` process, supervisor, persistence layer, RepoIntelService implementation,
or a claim that P4 is complete. It reads no filesystem, starts no tasks or threads,
performs no external calls, and has no Rust-side Thread, Memory, Workspace, or Guard
authority.

## Implemented slice

- Immutable base generations built only from caller-supplied file snapshots.
- Deterministic BLAKE3 content and generation digests over sorted paths and opaque
  caller pins.
- Strict normalized relative-path checks; paths are preserved as UTF-8 and compared
  byte-for-byte (no case folding or Unicode normalization).
- Bounded, deterministic, line-oriented lexical search with generation provenance.
- A separate immutable unsaved-buffer overlay pinned to an exact local base-generation
  digest and opaque editor version. It can replace bytes only for paths already in
  that base and never mutates the base. Per-file replacement and clearing produce a new
  overlay and recompute its bounded digest without rebuilding the repository base
  generation. A bounded atomic batch can combine replacements and clears against that
  same base; duplicate paths, oversized batches, invalid inputs, and final overlay-limit
  violations fail without changing the prior overlay. A batch is limited to 128 unique
  paths and 8 MiB of replacement bytes; the resulting overlay remains subject to the
  same file-count and aggregate-content limits.
- Generation and query status are always `PARTIAL`. Tree-sitter, LSP, SCIP, and vector
  enrichment are explicitly unavailable; this crate never reports `CURRENT`.

## Initial hard limits

These are implementation defaults, not policy-controlled limits:

| Input/work | Bound |
|---|---:|
| Base files | 4,096 |
| One file (base or overlay) | 1 MiB |
| Aggregate base content | 64 MiB |
| Aggregate base path bytes | 4 MiB |
| Overlay files | 128 |
| Changes in one overlay batch | 128 |
| Aggregate overlay content | 8 MiB |
| One normalized path | 1,024 UTF-8 bytes |
| One opaque pin/editor version | 4,096 bytes |
| Query | 256 UTF-8 bytes, non-empty, one line |
| Results | 1–100 matching lines |
| Search work | 4,194,304 counted byte/comparison steps per query |

Search scans files in path order and stops visibly when the work or result bound is
reached. The work meter charges line-boundary inspection and KMP byte comparisons;
the query/prefix-table size and number/path length of files are independently bounded
above. A `PARTIAL` result is not evidence that the caller supplied every readable file.

## Integration gaps

Repository/member identity, workspace binding, revision set, read scope, read policy,
source receipt, parser-set identity, and editor version enter as opaque caller pins.
The library binds these values into digests but cannot authenticate, interpret, or
authorize them. The integrating RepoIntelService/Workspace/Guard owners must validate
scope and receipts before supplying bytes, resolve platform path identity/case rules,
and decide generation lifecycle/freshness. This library has no filesystem traversal,
watchers, scheduling, cancellation lane, IPC, persistence, cache/reuse store, or
supervised-process behavior. Equal immutable inputs produce equal generation digests,
but unchanged-generation object reuse is not implemented.

## Local verification

From this directory:

```sh
cargo test --offline
cargo fmt --check
```
