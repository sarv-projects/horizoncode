# `indexd` library slice

This crate is a bounded lexical indexing library with a generation-bound RepoIntel
query adapter, opt-in rebuildable generation-pack cache, and deterministic watcher
event/lifecycle primitives. It is **not** an `hz-indexd` process, supervisor, complete
RepoIntelService implementation, or a claim that P4 is complete. The cache reads and
writes only its explicitly configured directory; watcher primitives start no OS
watchers or background tasks. Neither has Thread, Memory, Workspace, Guard, or ACL
authority.

## Implemented slice

- Immutable base generations built only from caller-supplied file snapshots.
- Deterministic BLAKE3 content and generation digests over sorted paths and opaque
  caller pins.
- Identical snapshots with identical pins reproduce a generation digest; changing a
  snapshot path or its bytes changes that digest. This is the library's implemented
  identity behavior, not a declaration of the architecture-level canonical digest
  preimage.
- Strict normalized relative-path checks; paths are preserved as UTF-8 and compared
  byte-for-byte (no case folding or Unicode normalization).
- `RepoIntelGeneration` exposes the existing `BaseGeneration` as a query adapter without
  duplicating its search engine. Its ID binds repository, optional workspace, revision
  set, read scope, read policy, source receipt, parser set, paths, and file bytes.
- Adapter queries carry the expected generation ID. Old generation IDs, overlays from
  another base, and stale/cross-query/cross-overlay cursors fail explicitly. Text
  results remain `PARTIAL`; symbol, references, impact, and expand operations return
  typed `UNAVAILABLE` until a real parser/LSP owner supplies them.
- Bounded, deterministic, line-oriented lexical search with generation provenance.
- Stable path-then-line cursor pagination. A bounded versioned token binds the exact
  query digest, base-generation digest, optional overlay digest, and last returned
  match. Malformed, cross-query, stale-generation/overlay, and non-matching anchors
  fail explicitly. A next cursor is returned only when the result cap truncates a page;
  work-limited results do not imply that more results are safely reachable. The result
  cap is per-page and may change between continuation calls; the path/line anchor keeps
  the ordered result stream contiguous without binding the cursor to a page size.
- A separate immutable unsaved-buffer overlay pinned to an exact local base-generation
  digest and opaque editor version. It can replace bytes only for paths already in
  that base and never mutates the base. Per-file replacement and clearing produce a new
  overlay and recompute its bounded digest without rebuilding the repository base
  generation. A bounded atomic batch can combine replacements and clears against that
  same base; duplicate paths, oversized batches, invalid inputs, and final overlay-limit
  violations fail without changing the prior overlay. A batch is limited to 128 unique
  paths and 8 MiB of replacement bytes; the resulting overlay remains subject to the
  same file-count and aggregate-content limits.
- Generation status is always `PARTIAL`. Text query status is `PARTIAL`, including
  bounded/truncated results; symbol/reference/impact/expand status is `UNAVAILABLE`.
  Tree-sitter, LSP, SCIP, and vector enrichment are not implemented; this crate never
  reports `CURRENT`.
- A bounded generation pack (`persist` module) encodes one immutable generation into a
  single deterministic, versioned, length-prefixed, checksummed frame and decodes it back
  into an identical generation digest. Decoding is the hostile-input boundary: the
  checksum is verified before parsing, every declared length is validated against the
  fixed library limits before bytes are taken, and truncated, trailing, oversized or
  malformed frames fail with typed errors.
- An opt-in `PersistentGenerationStore` stores those packs by content-derived generation
  digest using bounded byte/count budgets, create-new temporary files and atomic rename.
  Reopen validates checksums and digest identity; corrupt entries are evicted as rebuild
  misses. It has no cross-process lock, does not encrypt cached source, and grants no
  authority. The HostKernel owner must provide a private root scoped to its authenticated
  principal/workspace/policy and must still revalidate the live read grant before reuse.
- Watcher primitives classify bounded batches and coalesce event bursts with a capped
  debounce interval. Any disk modification, addition, or removal invalidates the immutable
  base and requires a rebuild; modified paths are re-read, never published as editor
  overlays. Overflow requests a full bounded rescan. `GenerationLifecycle` fences late
  builds with an invalidation epoch. These primitives do not watch the OS filesystem,
  schedule background work, authorize reads, or connect to HostKernel; the supervised
  host owner remains responsible for those lifecycles.
- A bounded RepoIntel transport (`transport` module) defines one versioned,
  length-prefixed, checksummed request frame and one response frame per
  `packages/opencode/src/tool/repo-intel.ts` `RepoIntelBackend` call: `build` (carrying a
  `GenerationPack`), `buildOverlay`, `query`, and both releases. Decoding is the hostile
  input boundary: the declared body length is bounded before allocation, the checksum is
  verified before the body is interpreted, and every declared field length must fit the
  remaining body. Semantic failures — unknown generation or overlay, stale cursor, invalid
  query, unusable overlay batch — are typed `TransportResponse::Error` values whose codes
  are exactly the TypeScript `RepoIntelBackendErrorCode` strings. Frame-level failures
  (direction, version, kind, declared length, checksum, truncation) return a typed
  `TransportError` and no response frame.
- An in-memory `upload` staging primitive accepts a HostKernel-generated opaque ID,
  declared pack length and digest, then appends contiguous chunks no larger than 512 KiB.
  It caps one store at two uploads and the existing generation-pack byte limit, expires
  uploads after 60 seconds, and returns a generation only after complete digest and pack
  validation. The API validates only upload-token length; it cannot authenticate the
  caller or bind principal, owner epoch, workspace or read ACL. The HostKernel caller must
  generate unpredictable IDs and own cancellation/disconnect/restart cleanup. This
  primitive is not an IPC schema or a production route.
- An in-memory `TransportHandler` applies decoded requests to retained generations and
  overlays and answers with those typed responses, so the wire contract is executable
  before it is integrated into the existing HostKernel. The handler
  performs no I/O, holds no leases and grants no authority; it dispatches queries through
  the same `RepoIntelGeneration` adapter and the same `BufferOverlay::apply_changes` batch
  path as the direct API instead of re-implementing them.

## RepoIntel transport wire contract

This section describes the crate's `transport`/`handler` frames. The codec uses one request
frame and one response frame per `RepoIntelBackend` call inside the indexd crate. This does
not imply that a frame fits in one HostKernel RPC; the `build` frame is larger than the
current HostKernel body limit, and no production bridge is wired.

### Envelope (both directions)

| Field | Bytes | Value |
|---|---:|---|
| magic | 4 | `HZRQ` request, `HZRS` response |
| version | 1 | `1` (`TRANSPORT_VERSION`) |
| kind | 1 | request/response kind tag (tables below) |
| body length | 4 | unsigned big-endian `u32`, bounded by the kind's cap |
| body | body length | kind-specific layout |
| checksum | 32 | BLAKE3 of `horizon.indexd.transport.v1\0` + everything before the checksum |

Decode order is fixed and test-pinned: minimum frame size, actual-size cap, declared body
cap, exact-length match (`Truncated`/`TrailingBytes`), checksum, magic, version, kind,
per-kind body cap, then body parse. A `peek_request_frame`/`peek_response_frame` call on the
first 10 bytes validates magic, version, kind and the declared cap without the checksum so a
stream reader knows exactly how many bytes to read next.

### Requests

| Kind | Tag | Operation | Body |
|---|---:|---|---|
| `REQUEST_BUILD` | 0 | `build` | exactly one `GenerationPack` frame (magic `HZIP`, version 1, checksummed) |
| `REQUEST_OVERLAY` | 1 | `buildOverlay` | generation id (32) ‖ editor version (len+bytes) ‖ change count (4) ‖ changes |
| `REQUEST_QUERY` | 2 | `query` | generation id (32) ‖ operation (1) ‖ query (len+bytes) ‖ max results (4) ‖ overlay present (1) ‖ [overlay digest (32)] ‖ cursor present (1) ‖ [cursor (len+bytes)] |
| `REQUEST_RELEASE_GENERATION` | 3 | `release` | generation id (32) |
| `REQUEST_RELEASE_OVERLAY` | 4 | `releaseOverlay` | overlay digest (32) |

`operation` tags are `0 text`, `1 symbol`, `2 references`, `3 impact`, `4 expand`
(`operation_tag`/`operation_from_tag`). A change is `path (len+bytes)` ‖ `tag (1: 0 clear,
1 replace)` ‖ `[contents (len+bytes)]`; a clear reveals that path's base bytes, like the
port's `contents: null`. `len` is an unsigned big-endian `u32`; digests are 32 raw bytes
(the `blake3:<hex>` string form is the host's concern; `Digest::parse`/`Digest::from_bytes`
and `Digest::to_tagged_string` are the seam).

### Responses

| Kind | Tag | Answers | Body |
|---|---:|---|---|
| `RESPONSE_BUILD` | 0 | `build` | generation id (32) |
| `RESPONSE_OVERLAY` | 1 | `buildOverlay` | base generation id (32) ‖ overlay digest (32) |
| `RESPONSE_QUERY` | 2 | `query` | generation id (32) ‖ status (1) ‖ payload |
| `RESPONSE_RELEASED` | 3 | either release | empty (acknowledgement) |
| `RESPONSE_ERROR` | 4 | any request | code (1) ‖ detail (len+bytes) |

Query status `0 PARTIAL`: overlay present (1) ‖ [overlay digest (32)] ‖ match count (4) ‖
matches (`path (len+bytes)`, `start line (u64)`, `end line (u64)`) ‖ cursor present (1) ‖
[cursor (len+bytes)] ‖ work units (u64) ‖ truncation (1: `0 none`, `1 work_limit`,
`2 result_limit`). Query status `1 UNAVAILABLE`: operation (1) ‖ overlay present (1) ‖
[overlay digest (32)]. The returned `next_cursor` token is opaque; send it back byte for
byte on the next request and never parse or rebuild it in the bridge. Responses are paired
with requests positionally, one frame per call; the envelope kind says which call was
answered.

### Limits

| Limit | Bound |
|---|---:|
| `build` body (one generation pack) | 72,351,744 bytes (`DEFAULT_MAX_PACK_BYTES`) |
| In-memory staging chunk / aggregate reservation / simultaneous uploads / TTL | 512 KiB / 72,351,744 bytes / 2 / 60 seconds |
| `buildOverlay` body | 8,524,968 bytes |
| `query` body | 2,735 bytes |
| release body | 32 bytes |
| query success response body | 106,884 bytes |
| error response body | 1,029 bytes (`MAX_ERROR_DETAIL_BYTES` = 1,024 detail bytes) |
| any frame | 72,351,786 bytes |
| overlay changes per request | 128 |
| overlay replacement bytes per request | 8 MiB aggregate, 1 MiB per file |
| editor version | 1..=4,096 bytes |
| query | 1..=256 UTF-8 bytes, one line |
| result limit | 1..=100 (`max results` outside the range is a typed response, see below) |
| matches per response | 100 |
| cursor | 2,400 bytes (`invalid_search_cursor` on malformed) |

`buildOverlay` mirroring rules: the batch must be non-empty, paths must be unique and
existing in the exact generation, replacements must be UTF-8 and within the per-file and
aggregate bounds, and a path cannot be both cleared and replaced. An empty batch is
rejected with `rejected`. Violations of a *framing* bound fail at decode with a
`TransportError` and produce no response frame: body caps, the 128-change count, an editor
version outside 1..=4,096 bytes, a declared field length that does not fit the body, and a
response carrying more than 100 matches. All other value failures become typed error
responses.

### Error mapping

`WireErrorCode` strings are exactly the `RepoIntelBackendErrorCode` literals of
`packages/opencode/src/tool/repo-intel.ts`:

`unavailable`, `rejected`, `generation_mismatch`, `cursor_generation_mismatch`,
`cursor_query_mismatch`, `cursor_overlay_mismatch`, `cursor_anchor_not_found`,
`cursor_work_limit`, `invalid_search_cursor`, `invalid_path`, `duplicate_path`,
`invalid_utf8`, `too_many_base_files`, `file_too_large`, `base_content_limit`,
`base_path_limit`, `empty_query`, `query_too_large`, `multiline_query`,
`invalid_result_limit`, `overlay_generation_mismatch`.

| Condition | Result |
|---|---|
| Unknown/released generation for `query`, `buildOverlay` | `generation_mismatch` |
| Unknown/released overlay, or overlay bound to another generation | `overlay_generation_mismatch` |
| Cursor from another generation / query / overlay | `cursor_generation_mismatch` / `cursor_query_mismatch` / `cursor_overlay_mismatch` |
| Cursor anchor missing or work-limited continuation | `cursor_anchor_not_found` / `cursor_work_limit` |
| Malformed cursor token | `invalid_search_cursor` |
| Empty / oversized / multiline query, bad result limit | `empty_query` / `query_too_large` / `multiline_query` / `invalid_result_limit` |
| `GenerationPack` decode failure (checksum, encoding, limits, duplicate path, non-UTF-8) | the matching code, or `rejected` when the port has no dedicated code |
| Overlay batch path/size/duplicate failures | `invalid_path`, `invalid_utf8`, `file_too_large`, or `rejected` |
| Any frame-level `TransportError` (no response frame exists) | `rejected` |

`unavailable` is never produced by a decoded frame: it is the port's "no transport is
wired" code and stays a caller-side decision. The `unavailable_reason.operation` and
`overlay_digest` fields of the TypeScript result map to the `UNAVAILABLE` payload and the
echoed overlay digest.

### HostKernel bridge status and bounded-design gate

There is no registered `indexd.v1` HostKernel operation or production mapping today. A
one-frame/one-RPC mapping is not viable: `MAX_BODY_BYTES` is 6,291,456 bytes, while one
`build` body may be 72,351,744 bytes. Putting that frame in a base64 string would expand it
to about 96,469,048 bytes; MessagePack binary values avoid that expansion but still exceed
the same HostKernel body cap. Kernel code also defines a 768 KiB artifact-chunk body
validator, but HostKernel dispatches no artifact-transfer operation; that validator is not
an indexd upload service.

The indexd crate must remain embedded/rebuildable under the existing HostKernel owner; do
not introduce a separate `hz-indexd` daemon. `GenerationPack` remains encoded and decoded
by Rust (`BaseGeneration::build` plus `GenerationPack::from_generation`); TypeScript must
not reimplement that format. The crate now includes inert bounded staging primitives, but
no HostKernel request contract, authenticated ingress, lifecycle cleanup integration or
production RepoIntel backend is approved or wired.

Proposal requirements to take to the HostKernel owner before implementation: bind each
staging upload to the authenticated peer principal, owner epoch/process incarnation, and a
validated Location/read-policy scope; enforce strict chunk offsets and whole-upload digest;
bound per-upload and aggregate staged bytes, concurrent uploads, and lifetime; and release
staging on explicit abort, cancellation, disconnect, owner restart, or expiry. The current
Core `requestHostKernel` cancellation option and Rust request handler only route cooperative
cancellation for `terminal.run`, so they do not establish indexd cancellation or cleanup.
Until the HostKernel owner settles and tests this interface, keep the production backend
unavailable. Once wired, frame/error mapping remains as above: decoded error frames map to
`RepoIntelBackendErrorCode`, while frame-level failures map to `rejected`.

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
| Serialized search cursor | 2,400 bytes |
| Search work | 4,194,304 counted byte/comparison steps per query |
| Generation pack frame | base content + base paths + 1 MiB framing/pin slack (hard decode cap) |
| Watcher batch | 256 changes |

Search scans files in path order and stops visibly when the work or result bound is
reached. The work meter charges line-boundary inspection and KMP byte comparisons;
the query/prefix-table size and number/path length of files are independently bounded
above. A `PARTIAL` result is not evidence that the caller supplied every readable file.
Continuation replays the same deterministic scan from the beginning to verify its
anchor, so earlier matches consume the same per-request work budget. If that bounded
scan reaches its work limit before the anchor, continuation fails explicitly rather
than returning a page that might skip or duplicate results. Cursor checksums detect
malformed/corrupted tokens; cursors are not authenticated and must never be used as an
authorization or scope proof.

## Integration gaps

Repository/member identity, workspace binding, revision set, read scope, read policy,
source receipt, parser-set identity, and editor version enter as opaque caller pins.
The library binds these values into digests but cannot authenticate, interpret, or
authorize them. The integrating RepoIntelService/Workspace/Guard owners must validate
scope and receipts before supplying bytes, resolve platform path identity/case rules,
and decide generation lifecycle/freshness. This library has no filesystem traversal,
OS watcher, background scheduling, cancellation lane, IPC or supervised-process behavior.
The `PersistentGenerationStore` is opt-in and stores bounded immutable packs only; its
caller still owns scope-specific cache roots and live authorization. The `watch` module
provides bounded event and invalidation primitives, not a watcher integration. The
`persist`, `transport` and `handler` modules also provide bounded frame/request/response
primitives, not authenticated IPC. Equal immutable inputs produce equal generation
digests, but no running HostKernel currently opens the persistent store or watcher.

The `TransportHandler` is a crate-side reference implementation, not a process or authority:
it owns no socket, supervisor, owner epoch, lease/Guard check, retention or eviction policy.
It retains every generation and overlay it is given until a release removes it (releasing a
generation also drops that generation's overlays). The existing HostKernel integration must
add authenticated scope binding, bounded lifecycle/retention, deadlines, cancellation and
backpressure without weakening the frame bounds or typed error mapping. Frame bytes are not
authentication: a decoded frame proves only internal consistency, and every
generation/overlay/cursor binding still has to match served state.

## Local verification

From this directory:

```sh
cargo test --offline --locked
cargo fmt --check
cargo clippy --offline --all-targets -- -D warnings
```

### P3 checkpoint — 2026-10-19

The full offline crate suite passed on the current P3 source revision:

```text
cargo test --locked --offline
lib 73/73; generation_store 7/7; persistence 8/8; repo_intel 5/5;
repo_structure 3/3; transport 9/9; upload 9/9; watch 6/6; doc tests 0; failures 0
```

The changed cache and watcher areas were also rerun directly:

```text
cargo test --manifest-path indexd/Cargo.toml --locked --offline --test generation_store --test watch
13 passed, 0 failed
cargo test --manifest-path indexd/Cargo.toml --locked --offline --lib watch::tests
8 passed, 0 failed
```

This verifies crate-local bounds, codec/cache corruption handling, in-memory upload
staging, watcher coalescing, and generation invalidation fences. It does not verify a
HostKernel bridge or production RepoIntel path. P3 therefore remains `PARTIAL` pending
the authenticated PermissionV2 read grant and Location-derived build/query seam, source
walker and OS watcher supervision, live cache/lifecycle ownership, and dependent parser,
LSP, and resource-owner acceptance. Symbol, reference, impact, and expand operations
remain typed `UNAVAILABLE`; the production backend remains disabled.

`repo_structure` exposes schema-derived `RepoStructureQueryV1` / `RepoStructurePageV1`
types and a generation-fenced adapter. The adapter validates query/page bounds, normalized
`rootRef`, host-derived workspace/revision provenance, and the expected source-generation
pin; until a structural parser/index is integrated, it returns `UNAVAILABLE` with
`sourceKind=none`, unknown freshness, zero coverage, no node references, and the explicit
`parser_unsupported` fallback. It does not resolve filesystem paths. HostKernel must
authenticate Session/Location from the private request envelope, derive and enforce the
live `files.read` grant, resolve `rootRef` beneath the registered Location, and mint any
continuation cursor before this adapter can be exposed to product traffic.
