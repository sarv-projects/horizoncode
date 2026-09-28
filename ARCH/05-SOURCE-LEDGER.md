# 05 — Source Ledger

What HorizonCode **builds**, **depends on**, or only **studies**. Entries are organized by role; concrete upstream identities and pinned revisions live in provenance records and [`research docs/`](../research%20docs/). Factual provider/model names may appear where needed for configuration and billing (`DEC-030`). Attribution that a license requires is generated into `THIRD-PARTY-NOTICES.md` at release and **shipped with the binary** (`TODO.md` `AX-010`).

For implementation lookup, [29-SOURCE-TRACEABILITY.md](29-SOURCE-TRACEABILITY.md)
maps design owners to current local entry points and pinned peer files. A `Pattern`
row below means research influence only. It is not a record that peer source was
copied, adapted successfully, or verified in HorizonCode; actual adaptation requires
the provenance record described in §2.

Legend: **Build** = first-party code · **Depend** = consume a library/SDK · **Pattern** = study only, no code · **Data** = consume data, not code · **Avoid** = never link, copy, or vendor.

## 1. Disposition by layer

| Layer | Disposition | Source role | License |
|---|---|---|---|
| Agent loop & scheduler | **Build** | Patterns evaluated across Rust, TypeScript, and Go harnesses | pattern only |
| Turn/stream event vocabulary | **Pattern** | Two agent CLIs | pattern only |
| Tool plane (native tools) | **Build** | Pattern from multiple harnesses | pattern only |
| Tool registry + permission-filtered materialization | **Build** | Pattern from TS harness | pattern only |
| Policy guard (allow/ask/deny) | **Build** | Pattern for ordering/amendment semantics | pattern only |
| Audit (hash chain / Merkle) | **Build** | — (blake3 as dependency) | — |
| Context engine + repo map | **Build** | Repo-map ranking algorithm adapted | permissive (see §2) |
| Compaction | **Build** | Pattern from TS harness | pattern only |
| Provider transports / route abstraction | **Build** | Pattern for provider-quirk isolation | pattern only |
| Provider/model catalog | **Data** | External catalog + snapshot client | permissive |
| Routing strategies | **Build** | Pattern for strategy shapes only | pattern only |
| Sub-agent orchestration & merge | **Build** | Pattern from harnesses | pattern only |
| Sandbox | **Depend** | Confinement crates + subprocess wrapper | permissive / LGPL-as-subprocess |
| Tree-sitter / LSP / SCIP | **Depend** | Parser, LSP client, index ingest | permissive |
| Git / worktrees | **Depend** | git library + system git | permissive |
| SQLite persistence | **Depend** | Embedded DB + driver | public domain / permissive |
| TUI rendering | **Depend** | ratatui + crossterm | permissive |
| CLI / config / hashing / WASM | **Depend** | clap, serde, blake3, wasmtime | permissive |
| ACP / MCP | **Depend** | Official protocol SDKs | permissive |
| Plugins / skills | **Build** + sandbox | — | — |
| Copyleft editors/TUIs, source-available licenses, restricted dual-license subtrees, unlicensed repos, closed products | **Avoid** | — | no-go |

## 2. Named entries

Reference entries are indexed by role **in shipped docs** (`DEC-011`). That is a
shipped-doc convention, not a licence shield: for every entry marked **Adapt** or
**Vendor**, the *in-tree* provenance record is mandatory and MUST carry the upstream
identity, the pinned commit/revision, the license, the upstream copyright line, and a
plain statement of what was modified — satisfying the attribution and change-notice
obligations of permissive licenses such as Apache-2.0 §4. Mandatory legal attribution
is exempt from the brand-neutral rule (`DEC-011`). Each row below is backed by a public
URL and a dated research note when available. A local clone is not reproducible evidence
unless its remote and pinned commit are recorded; machine-specific checkout paths are
deliberately excluded.

> **Pattern note.** The anchored compaction-summary structure in `ARCH/09` §4 and the
> output-formatter strategy in `ARCH/19` are **patterns we implement in our own words
> and code** — not upstream template text. No upstream template is transcribed.

| ID | Role | Disposition | License | What we take |
|---|---|---|---|---|
| `SRC-001` | TypeScript reference harness | **Pattern** | MIT | Candidate patterns for loop, tool registry, context budgets, providers, ACP mapping, and headless CLI; compare with other systems rather than treating as the baseline |
| `SRC-002` | Rust agent CLI (control plane) | **Pattern** | Apache-2.0 | Turn/steer model, OS sandbox types, policy-as-data + amendment-with-scope, app-server protocol v2, approval taxonomy, secret-env filtering |
| `SRC-003` | Rust TUI agent | **Pattern** | Apache-2.0 | ratatui TUI structure, checkpoint/rewind, sandbox profile matrix, folder-trust gate, goal subsystem, two-pass compaction |
| `SRC-004` | Plugin-kernel agent runtime | **Pattern** | MIT | Profile/bundle/patch composition, waterfall taxonomy, guarded sub-call, migration discipline |
| `SRC-005` | Editor-embedded agent | **Pattern** | Apache-2.0 | MCP hub (transports, OAuth, debounce/dedupe), plan/act guard, checkpoint/restore transactions, retry guards |
| `SRC-006` | Multi-provider gateway | **Pattern** | MIT (core); restricted `enterprise/` subtree = **Avoid** | Routing strategy shapes, typed fallback, cooldown, budget gates |
| `SRC-007` | Minimal TS coding agent | **Pattern** | MIT | Provider-quirk isolation, cross-provider context handoff, abort-everywhere, split tool results, scrollback-native differential rendering |
| `SRC-008` | Repo-map ranking | **Adapt** | Apache-2.0 | Tree-sitter tag graph + PageRank ranking. In-tree provenance is mandatory and concrete: upstream identity, pinned commit, Apache-2.0 license reference + upstream copyright line, and a statement of modifications (ranking logic ported/reorganized; our graph construction, budget model, and session personalization differ from upstream). Shipped references are factual attribution or user-relevant provenance, never an unsupported comparison. |
| `SRC-009` | Model catalog dataset + client | **Data** | **MIT — confirmed with evidence** (see §5) | Provider/model metadata. Grant verified from primary sources: upstream repository `LICENSE` is MIT, `Copyright (c) 2025 models.dev`; the typed client package declares `"license": "MIT"`; no data-specific license, no proprietary-subdirectory carve-out, and no non-commercial or share-alike clause found. Redistribution is permitted **provided the copyright line and permission notice travel with the distribution** — enforced via `THIRD-PARTY-NOTICES` + `--credits` (`AX-010`). Residual and unresolved upstream: pseudonymous holder, no contributor agreement, unaddressed database rights, no accuracy warranty, and **third-party marks (provider/model logos) that the grant cannot convey**. Posture in `DEC-021`. |
| `SRC-010` | ACP protocol SDK | **Depend** | Apache-2.0 | JSON-RPC stdio transport + schema |
| `SRC-011` | MCP protocol SDK | **Depend** | MIT/Apache-2.0 | Host-side client, stdio + streamable HTTP |
| `SRC-012` | Sandbox crates | **Depend** | MIT/Apache-2.0 | Landlock bindings, seccomp bindings; bubblewrap invoked as subprocess |
| `SRC-013` | Parser / LSP / index | **Depend** | MIT / Apache-2.0 | tree-sitter, LSP client, SCIP ingest |
| `SRC-014` | Git / DB / CLI / TUI / hash / WASM | **Depend** | permissive | gitoxide, rusqlite, clap, ratatui, crossterm, blake3, wasmtime |
| `SRC-015` | Skill file convention | **Adopt** (convention) | open standard | `SKILL.md` discovery, frontmatter, description routing, progressive disclosure |
| `SRC-016` | Plugin + hook convention | **Pattern** | — | Manifest + component dirs + marketplace install + hook-matching shape |
| `SRC-017` | Analytics CLI shape | **Pattern** | permissive | Local usage ledger with `stats`/`export`/insights surfaces; priced locally |
| `SRC-018` | MCP registry listing model | **Reference** | — | Enumeration model only; never auto-installed, trust defined by HorizonCode |
| `SRC-019` | OpenCode provider/catalog architecture | **Pattern** | MIT at pinned repository commit; do not assume the separately served live feed shares that license; current provider/docs behavior remains volatile | Provider/model catalog separation, protocol/auth package inventory, Go request identity; HorizonCode implements its own Rust adapter and does not copy TypeScript code or full feed records; research retains provider IDs/names, documented auth coverage, counts/digests only, with no live auth hints or credentials |
| `SRC-020` | The Update Framework specification | **Reference** | Specification reference; no implementation code copied | Threat model and signed root/timestamp/snapshot/targets metadata for update design; a candidate Rust dependency needs a separate license/security review |
| `SRC-021` | OpenCode Go service/provider docs and live directories | **Reference** | Public protocol documentation; no source-code or live-feed data-license claim | Volatile Go model IDs and documented endpoint mapping, own User-Agent and stable session header; research records provider IDs/names, documented auth coverage, Go IDs, counts/digests and docs-derived route mappings only, not full API responses; do not assume future client compatibility |
| `SRC-022` | xAI Grok Build workflow authoring/runtime | **Pattern** | Apache-2.0 at pinned commit `f0e3be1100ef5252488e3be8bb0e91cf68d8c305`; no code copied | Workflow creation and phase validation, bounded execution, cancellation/quota, journal/replay-diagnostic ideas. The observed Rust/Rhai runtime is not adopted; source notes disclose same-process-only pause/resume and uncertain external-effect replay. HorizonCode templates remain data executed by its own Run controller. |
| `SRC-023` | Helix editor architecture | **Pattern** | MPL-2.0 project; no code/dependency adopted | Pinned to `helix-editor/helix` commit `079a789e8cb08ead67f19e1971a1b7438b37354b` (2026-07-23); `LICENSE` confirms MPL-2.0. Separation of editing primitives, LSP, view/editor state and terminal UI informs module boundaries only. MPL files are excluded from copying/linking under `DEC-001`/`DEC-012`; see `research docs/helix-editor.md`. |
| `SRC-024` | Agent ecosystem, swarm, quota, and long-horizon harnesses | **Pattern** | Per-repository licenses and exact SHAs are recorded in `research docs/agent-ecosystem-review.md` and `research docs/long-horizon-repo-review.md`; Superset is Elastic-2.0, and no code is copied | Compare process-local vs durable worker ownership, budget observation vs atomic reservation, typed questions, agent profiles, and revision-fenced evaluation. Findings are path-scoped and do not claim every file or peer behavior. |
| `SRC-025` | Agent UI, tool, and context optimization review | **Pattern** | Per-repository licenses and exact SHAs are recorded in `research docs/ui-runtime-tools-review.md`; copyleft and license-conflict repositories remain pattern-only | Compare web/control-plane boundaries, thread UI state, structural search, local indexing, tool-output transforms, editor and coding benchmarks. No source is copied; transformed output must preserve original evidence and measure semantic regressions. |
| `SRC-026` | Warp orchestration UI and oh-my-pi agent runtime | **Pattern** | Exact pins, observed licenses, and scoped source paths are in `research docs/warp-ohmypi-review.md`; Warp is not treated as blanket MIT because its workspace declares AGPL-3.0-only, and no code was copied | Compare typed-origin/idempotent message delivery, client/server receipt boundaries, provider-registry completeness, ordered parallel tool results, explicit process-vs-power-loss durability, compaction replay metadata, and subagent isolation. Focused source trace only; peer tests were not run and some test paths were only identified. |

## 3. Hard no-go

Never link, copy, or vendor: any copyleft (GPL/AGPL) project, any non-OSI/source-available TUI, any restricted-dual-license `enterprise`/`ee` subtree, any repository with no or empty license, and any closed product (patterns and interfaces only).

**Pattern reuse is not code reuse.** Research notes may inspire behavior and record
trade-offs, but source code, generated schemas, tests, fixtures, documentation, and
assets are separate copyright/licensing surfaces. Before adapting material, pin the
exact repository revision and path, inspect the applicable license and notices, check
compatibility with the intended distribution, record modifications, and obtain review
under `AX-010`/`AX-012`. Do not infer a license from a repository badge or copy across a
different-license subdirectory. Where source is private or unavailable, record the
boundary and use public documentation/research only.

## 4. Enforcement

- Dependency allowlist check runs in CI; a violation fails the build (`DEC-012`).
- Every **Adapt**/**Vendor** entry carries an in-tree provenance record — upstream
  identity, pinned commit, license, upstream copyright line, and the statement of
  modifications (Apache-2.0 §4-complete). A missing or incomplete record fails the
  build.
- `THIRD-PARTY-NOTICES.md` (or an equivalent generated bundle) is generated at release
  from the resolved dependency graph **and shipped with the binary**; a release
  without it fails the release check (`TODO.md` `AX-010`).
- Mandatory legal attribution is unconditional; stripping or paraphrasing required
  notices is itself a build failure (`DEC-011`, `DEC-030`).

**Source status (2026-09-28).** The bundle and its gate are implemented
(`AX-010`). `horizoncode notices generate` renders `THIRD-PARTY-NOTICES.md` from
the pinned `Cargo.lock` and from the license/notice files of the package sources
that are present for the generating platform: each registry package's `license`
expression and its verbatim `LICENSE`/`COPYING`/`NOTICE`/`UNLICENSE` documents,
deduplicated per expression. Packages whose sources are absent (built for another
target platform) are listed explicitly under *not resolved on the generating
platform* rather than omitted. The bundle is embedded in the binary and printed
by `horizoncode --credits`, which needs no store, provider, or environment.

`horizoncode notices check` and the unit gate apply three rules instead of byte
equality, because which sources are unpacked varies by machine: the lockfile
digest named in the bundle must match `Cargo.lock`; every locked package must
appear in the bundle and nothing may appear that is not in the lock graph; and
every package whose source is present locally must appear in the resolved table
with its shipped license expression and all of its notice texts. A locally built
package can therefore never be hidden in the unresolved section or lose its
notice. **Not covered here:** the dependency allowlist check and quarantine
(`G-1`, `DEC-012`) and the in-tree provenance records for `Adapt`/`Vendor` rows,
which have no entries yet.

## 5. Model catalog provenance record (`SRC-009`)

**Grant verified from primary sources.**

- Upstream repository `LICENSE`: MIT, `Copyright (c) 2025 models.dev`; the repository
  license API reports `spdx: MIT`.
- The typed client package metadata declares `"license": "MIT"`.
- No data-specific license, no proprietary-subdirectory carve-out, and no
  non-commercial or share-alike clause was found in the repository tree, the package
  metadata, or the published terms.
- Upstream repository identity is in flux across organization renames. Any snapshot
  MUST pin a commit hash and record the remote URL together with the retrieval date.

**What the grant does and does not cover.**

- It permits redistribution, sublicensing, and inclusion in a proprietary or
  permissively licensed binary on one condition: the copyright line and the
  permission notice travel with the distribution. That condition is enforced
  mechanically through `THIRD-PARTY-NOTICES` and a `--credits` / `about` surface
  (`AX-010`, `DEC-011`).
- It grants **no trademark rights**. Provider and model logos inside the dataset are
  third-party marks that the grant cannot convey, so they are never redistributed.
- It provides **no accuracy warranty**; upstream disclaims fitness entirely. Pricing
  and limit errors are our operational liability, not a license breach.
- The holder is a project pseudonym and no contributor agreement was found; EU sui
  generis database rights are unaddressed by the grant text. Accepted as residual
  risk, bounded by per-row provenance rather than by a stronger license claim.

**Posture.** See `DEC-021`: a curated subset as the built-in primary, opt-in runtime
enrichment, no full dataset snapshot, no bundled marks, and unconditional notice
retention.

**Secondary references — cross-check only, never bundled as primary.** A permissively
licensed community model-cost map maintained outside its proprietary subdirectory is
used solely to cross-verify curated rows; provider-published documentation is the
authority of record. Aggregator model listings that carry no dataset license are
runtime-only and MUST NOT be bundled.
