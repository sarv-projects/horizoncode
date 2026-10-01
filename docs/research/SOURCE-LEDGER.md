# 05 — Source Ledger

What HorizonCode **builds**, **depends on**, or only **studies**. Entries are organized by role; concrete upstream identities and pinned revisions live in provenance records and [`research docs/`](../../research%20docs/). Factual provider/model names may appear where needed for configuration and billing (`DEC-030`). Attribution that a license requires is generated into `THIRD-PARTY-NOTICES.md` at release and **shipped with the binary** (`TODO.md` `AX-010`).

For implementation lookup, [29-SOURCE-TRACEABILITY.md](SOURCE-TRACEABILITY.md)
maps design owners to current local entry points and pinned peer files. A `Pattern`
row below means research influence only. It is not a record that peer source was
copied, adapted successfully, or verified in HorizonCode; actual adaptation requires
the provenance record described in §2.

Legend: **Build** = first-party code · **Depend** = consume a library/SDK · **Pattern** = study only, no code · **Proposed synthesis** = a first-party design idea with no upstream implementation claimed · **Data** = consume data, not code · **Avoid** = never link, copy, or vendor. A subprocess boundary alone does not waive copyleft obligations: review each exact dependency/version and its linking, relinking, source, notice, and other license terms before use; absent an approved compliance path, treat it as no-go.

## 1. Disposition by layer

| Layer | Disposition | Source role | License |
|---|---|---|---|
| Agent loop & scheduler | **Build** | Patterns evaluated across Rust, TypeScript, and Go harnesses | pattern only |
| Turn/stream event vocabulary | **Pattern** | Two agent CLIs | pattern only |
| Tool plane (native tools) | **Build** | Pattern from multiple harnesses | pattern only |
| Tool registry + permission-filtered materialization | **Build** | Pattern from TS harness | pattern only |
| Policy guard (allow/ask/deny) | **Build** | Pattern for ordering/amendment semantics | pattern only |
| Audit (hash chain / Merkle) | **Build** | — (blake3 as dependency) | — |
| Context engine + repo map | **Build** | Repo-map ranking is a proposed synthesis; no external implementation is claimed as adapted | no external source adopted |
| Compaction | **Build** | Pattern from TS harness | pattern only |
| Provider transports / route abstraction | **Build** | Selective, license-checked provider behavior adaptation allowed from monitored OpenCode/Cline sources; otherwise implement from docs | per-file license review before adaptation |
| Provider/model catalog | **Data** | External catalog + snapshot client | permissive |
| Routing strategies | **Build** | Pattern for strategy shapes only | pattern only |
| Sub-agent orchestration & merge | **Build** | Pattern from harnesses | pattern only |
| Sandbox | **Depend** | Confinement crates + subprocess wrapper | each exact crate/version requires a license and notice review; a subprocess boundary alone does not resolve copyleft obligations |
| Tree-sitter / LSP / SCIP | **Depend** | Parser, LSP client, index ingest | permissive |
| Git / worktrees | **Depend** | separately reviewed git library; optional system Git invocation | Library-specific; system Git is GPLv2, not permissive; bundling/linking needs separate clearance |
| SQLite persistence | **Depend** | Embedded DB + driver | public domain / permissive |
| TUI rendering | **Depend** | ratatui + crossterm | permissive |
| CLI / config / hashing / WASM | **Depend** | clap, serde, blake3, wasmtime | permissive |
| ACP / MCP | **Depend** | Official protocol SDKs | permissive |
| Plugins / skills | **Build** + sandbox | — | — |
| Copyleft editors/TUIs, source-available licenses, restricted dual-license subtrees, unlicensed repos, closed products | **Avoid** | — | no-go |

## 2. Named entries

Reference entries are indexed by role **in shipped docs** (`DEC-011`). That is a
shipped-doc convention, not a licence shield: for every entry marked **Adapt** or
**Vendor**, the *in-tree* provenance record is mandatory before adaptation or distribution and MUST carry the upstream
identity, the pinned commit/revision, the license, the upstream copyright line, and a
plain statement of what was modified — satisfying the attribution and change-notice
obligations of permissive licenses such as Apache-2.0 §4. Mandatory legal attribution
is exempt from the brand-neutral rule (`DEC-011`). Each row below is backed by a public
URL and a dated research note when available. A local clone is not reproducible evidence
unless its remote and pinned commit are recorded; machine-specific checkout paths are
deliberately excluded.

> **Pattern note.** The anchored compaction-summary structure in `ARCH/core/CONTEXT.md` §4 and the
> output-formatter strategy in `ARCH/core/COMPRESSION.md` are **patterns we implement in our own words
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
| `SRC-008` | Repo-map ranking | **Proposed synthesis** | not applicable; no external source adopted | Tree-sitter tags plus PageRank are a proposed first-party design synthesis; no single upstream implementation is claimed or adapted. If implementation later follows a specific upstream source, add a separate exact pinned provenance record before adapting it. |
| `SRC-009` | Model catalog dataset + client | **Data** | **MIT — confirmed with evidence** (see §5) | Provider/model metadata. Grant verified from primary sources: upstream repository `LICENSE` is MIT, `Copyright (c) 2025 models.dev`; the typed client package declares `"license": "MIT"`; no data-specific license, no proprietary-subdirectory carve-out, and no non-commercial or share-alike clause found. Redistribution is permitted **provided the copyright line and permission notice travel with the distribution** — enforced via `THIRD-PARTY-NOTICES` + `--credits` (`AX-010`). Residual and unresolved upstream: pseudonymous holder, no contributor agreement, unaddressed database rights, no accuracy warranty, and **third-party marks (provider/model logos) that the grant cannot convey**. Posture in `DEC-021`. |
| `SRC-010` | ACP protocol SDK | **Depend** | Apache-2.0 | JSON-RPC stdio transport + schema |
| `SRC-011` | MCP protocol SDK | **Depend** | MIT/Apache-2.0 | Host-side client, stdio + streamable HTTP |
| `SRC-012` | Sandbox crates | **Depend** | MIT/Apache-2.0 | Landlock bindings, seccomp bindings; bubblewrap invoked as subprocess |
| `SRC-013` | Parser / LSP / index | **Depend** | MIT / Apache-2.0 | tree-sitter, LSP client, SCIP ingest |
| `SRC-014` | Git / DB / CLI / TUI / hash / WASM | **Depend** | permissive | gitoxide, rusqlite, clap, ratatui, crossterm, blake3, wasmtime |
| `SRC-015` | Skill file convention | **Adopt** (convention) | open standard | `SKILL.md` discovery, frontmatter, description routing, progressive disclosure |
| `SRC-016` | Plugin + hook convention | **Pattern** | Documentation/source-specific; no code adopted | Manifest + component dirs + marketplace install + inspectable hook lifecycle and structured JSON contract. Grok docs document project-hook trust and JSON stdin/stdout, but also fail-open hook errors; HorizonCode does not adopt that failure policy. Codex hook docs inform source/digest review and disable/inspect UX. See `docs/research/SOURCE-TRACEABILITY.md` `U-GROK-HOOKS` and `U-CX-HOOKS` when added. |
| `SRC-017` | Analytics CLI shape | **Pattern** | permissive | Local usage ledger with `stats`/`export`/insights surfaces; priced locally |
| `SRC-018` | MCP registry listing model | **Reference** | — | Enumeration model only; never auto-installed, trust defined by HorizonCode |
| `SRC-019` | OpenCode provider/catalog architecture | **Pattern + Adapt candidate** | MIT at pinned repository commit; confirm exact file, included notices, and changed license at each source pin; do not assume the separately served live feed shares that license | Provider/model catalog separation, protocol/auth mapping, and documented provider connector behavior. Selective source adaptation is allowed only after per-file review under §2 and recording the exact copied/modified portions; no bulk port, auth store, client identity, cookies, OAuth IDs, remote executable, or complete feed records. |
| `SRC-020` | The Update Framework specification | **Reference** | Specification reference; no implementation code copied | Threat model and signed root/timestamp/snapshot/targets metadata for update design; a candidate Rust dependency needs a separate license/security review |
| `SRC-021` | OpenCode Go service/provider docs and live directories | **Reference** | Public protocol documentation; no source-code or live-feed data-license claim | Volatile Go model IDs and documented endpoint mapping, own User-Agent and stable session header; research records provider IDs/names, documented auth coverage, Go IDs, counts/digests and docs-derived route mappings only, not full API responses; do not assume future client compatibility |
| `SRC-022` | xAI Grok Build workflow authoring/runtime | **Pattern** | Apache-2.0 at pinned commit `f0e3be1100ef5252488e3be8bb0e91cf68d8c305`; no code copied | Workflow creation and phase validation, bounded execution, cancellation/quota, journal/replay-diagnostic ideas. The observed Rust/Rhai runtime is not adopted; source notes disclose same-process-only pause/resume and uncertain external-effect replay. HorizonCode templates remain data executed by its own Run controller. |
| `SRC-023` | Helix editor architecture | **Pattern** | MPL-2.0 project; no code/dependency adopted | Pinned to `helix-editor/helix` commit `079a789e8cb08ead67f19e1971a1b7438b37354b` (2026-07-23); `LICENSE` confirms MPL-2.0. Separation of editing primitives, LSP, view/editor state and terminal UI informs module boundaries only. MPL files are excluded from copying/linking under `DEC-001`/`DEC-012`; see `research docs/helix-editor.md`. |
| `SRC-024` | Agent ecosystem, swarm, quota, and long-horizon harnesses | **Pattern** | Per-repository licenses and exact SHAs are recorded in `research docs/agent-ecosystem-review.md` and `research docs/long-horizon-repo-review.md`; Superset is Elastic-2.0, and no code is copied | Compare process-local vs durable worker ownership, budget observation vs atomic reservation, typed questions, agent profiles, and revision-fenced evaluation. Findings are path-scoped and do not claim every file or peer behavior. |
| `SRC-025` | Agent UI, tool, and context optimization review | **Pattern** | Per-repository licenses and exact SHAs are recorded in `research docs/ui-runtime-tools-review.md`; copyleft and license-conflict repositories remain pattern-only | Compare web/control-plane boundaries, thread UI state, structural search, local indexing, tool-output transforms, editor and coding benchmarks. No source is copied; transformed output must preserve original evidence and measure semantic regressions. |
| `SRC-026` | Warp orchestration UI and oh-my-pi agent runtime | **Pattern** | Exact pins, observed licenses, and scoped source paths are in `research docs/warp-ohmypi-review.md`; Warp is not treated as blanket MIT because its workspace declares AGPL-3.0-only, and no code was copied | Compare typed-origin/idempotent message delivery, client/server receipt boundaries, provider-registry completeness, ordered parallel tool results, explicit process-vs-power-loss durability, compaction replay metadata, and subagent isolation. Focused source trace only; peer tests were not run and some test paths were only identified. |
| `SRC-027` | Cline provider SDK and integrations | **Pattern + Adapt candidate** | Cline repository license is Apache-2.0 at the inspected repository license; no blanket file-level clearance is claimed. Check the exact pinned file, package notices, generated/vendor content, and any third-party subdirectory/license before copying. | Provider registry, request/stream handlers, model mappings, and documented auth/setup behavior may inform or be selectively adapted into HorizonCode-owned Rust adapters after per-file provenance review. Do not ship Cline's JS/AI SDK runtime, credentials, OAuth/client identity, or generated catalog wholesale. Exact provider paths and source pin are tracked in `docs/research/SOURCE-TRACEABILITY.md` and `research docs/cline.md`; no provider code is currently recorded as copied. |
| `SRC-029` | xAI Grok Build extension-manager navigation | **Pattern** | Apache-2.0 at pinned commit `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`; no code copied | One category-aware Extensions modal with slash-command deep links for hooks, plugins, skills, MCP servers, workflows, and marketplace. HorizonCode adopts only the navigation pattern; its Search/Installed/Create transaction, trust, guard, and noninteractive-surface behavior remain HorizonCode-owned. See `research docs/grok-build-extensions.md` and `docs/research/SOURCE-TRACEABILITY.md` `U-GROK-EXTENSIONS`. |
| `SRC-028` | Kilo Code semantic indexing | **Pattern** | No code adopted; exact docs/repository pin is in `docs/research/SOURCE-TRACEABILITY.md` and `research docs/kilocode-indexing.md`; any future source adaptation requires separate per-file review | Opt-in Tree-sitter chunking, configurable embeddings/vector store, and semantic-search surface as an architecture reference only. |
| `SRC-030` | Grok Build Doctor diagnostics and named-fix flow | **Pattern** | Apache-2.0 at pinned commit `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`; no code copied | Shared typed local diagnostic report, stable IDs, explicit unavailable states, human/JSON projections, and named repair planning. HorizonCode uses its own authenticated Guard, audit, and owned config path; Grok's `--yes` and terminal-specific fixes are not adopted. See `research docs/grok-build-doctor.md` and `docs/research/SOURCE-TRACEABILITY.md` `U-GROK-DOCTOR`. |
| `SRC-031` | Grok Build skill invocation and guided creation | **Pattern** | Apache-2.0 at pinned commit `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`; no code copied | Source-qualified skill names preserve collisions with built-ins; `/create-skill` guides scope and package drafting. HorizonCode uses its own deterministic registry, digest recheck, guarded preview/write, and shared Extensions Create view. See `research docs/agent-tool-skill-command-adoption.md` and `docs/research/SOURCE-TRACEABILITY.md` `U-GROK-SKILLS`. |
| `SRC-032` | Codex deferred tool search | **Pattern** | Apache-2.0 at pinned commit `67a709665ac7b50311b93e32612c9a8281684787`; no code copied | Keep full schemas deferred, search bounded metadata, and materialize selected tools. BM25 is observed but not mandated; HorizonCode ranking requires its own relevance evaluation. See `research docs/agent-tool-skill-command-adoption.md` and `docs/research/SOURCE-TRACEABILITY.md` `U-CX-TOOL-SEARCH`. |
| `SRC-033` | OpenCode grouped LSP tool | **Pattern** | MIT at pinned commit `b471c2b4495747353af768fbf2e0790c9d820ce2`; no code copied | One tool groups read-only symbol/navigation/call-hierarchy operations and checks file/server/permission boundaries. HorizonCode routes through its single `CMP-repo-intel` owner and adds revision-bound results/fallbacks. See `research docs/agent-tool-skill-command-adoption.md` and `docs/research/SOURCE-TRACEABILITY.md` `U-OC-LSP`. |
| `SRC-034` | Codex, Grok Build, and OpenCode compaction policies | **Pattern** | Codex Apache-2.0, Grok Build Apache-2.0, OpenCode MIT at pins in `docs/research/SOURCE-TRACEABILITY.md`; no code copied | Compare context-window threshold and reserve semantics and regression lessons for automatic-path gating. Upstream percentages differ and are not treated as a universal default; HorizonCode's 50% remains its own decision. See `research docs/compaction-upstream-comparison.md` and `docs/research/SOURCE-TRACEABILITY.md` `U-CTX-COMPACTION`. |
| `SRC-035` | iCode TUI, interaction, and context-budget patterns | **Pattern** | iCode repository at pin `bb45692104bc1d26882729e90fc145e3a114e066`; behavior pattern only | Shared action entry points, inline suggestions, responsive path scan, focused task/workflow/diff/approval surfaces, extension-control interaction, and separate output/safety budget awareness inform HorizonCode. Keep HorizonCode's three-pane layout, Guard policy, task-first rows, simple Extensions default, selected 0.5 compaction threshold, and native controller/runtime. No project-file Explorer is attributed to iCode. See `research docs/icode-ui-review.md` and `docs/research/SOURCE-TRACEABILITY.md` `U-ICODE-TUI`/`U-ICODE-COMPACTION`. |
| `SRC-036` | Codex/Agent Plugins, Claude Code marketplaces, Grok Build extensions/connectors, MCP Registry, and Agent Skills | **Pattern** | Official docs/spec/API sources checked 2026-09-30; exact source URLs and observed limits in `research docs/extension-marketplace-review.md` and `docs/research/SOURCE-TRACEABILITY.md` `U-EXTENSION-ECOSYSTEM` | Federated catalog sources, package-family boundaries, Git marketplace adapters, MCP registry synchronization, shared Extensions destination, user-facing Connector service identity, and progressive skill metadata/body loading. Design pattern only; no source implementation, manifest schema, registry data, or executable package copied. Compatibility must be documented per adapter; closed vendor catalogs and credentials are not reused. |
| `SRC-037` | AutoGPT Platform installer/environment identity | **Pattern only** | AutoGPT commit `39856ae4533ce7025647dfc6e899a1c56f1324e5`; `autogpt_platform/` is PolyForm Shield 1.0.0 with a noncompete term; no code/adaptation | Installer's env-file and immutable-image digest checks are scoped to its appliance. No source from `autogpt_platform/` is copied, adapted, or used as a dependency. See `research docs/architecture-evolution-review-2026-09.md` and `docs/research/SOURCE-TRACEABILITY.md` `U-AUTOGPT-ENV`. |
| `SRC-038` | planning-with-files | **Pattern only** | MIT at pinned commit `51c1caa27f9fefe259e45a7cc92fa79ee8787cd7`; no code copied | Bounded durable working notes and explicit completion checks inform a rebuildable `ExecutionBrief`; project Markdown is not canonical state. Hook/file contents remain untrusted. See `research docs/architecture-evolution-review-2026-09.md` and `docs/research/SOURCE-TRACEABILITY.md` `U-PLANNING-FILES`. |
| `SRC-039` | LobsterAI product/runtime separation and config rendering | **Pattern only** | MIT observed at pinned commit `791a352dee3b3d8c6f64edcaf229ce474a68f6c5`; no code copied | Runtime/config translation is an adapter pattern only; no OpenClaw/Electron runtime, foreign schema, permissions, or lifecycle are adopted. See `research docs/architecture-evolution-review-2026-09.md` and `docs/research/SOURCE-TRACEABILITY.md` `U-LOBSTERAI`. |
| `SRC-040` | SuperAGI and toolkit bundling | **Ecosystem signal only** | MIT observed at pinned commit `c3c1982e7bd6a11cfed53c5a193ea502f924b1b6`; no code copied; current activity/compatibility not audited | Historical toolkit grouping may inform capability taxonomy; it is not an architecture or parity authority. See `research docs/architecture-evolution-review-2026-09.md` and `docs/research/SOURCE-TRACEABILITY.md` `U-SUPERAGI`. |
| `SRC-041` | AG-UI protocol documentation | **Protocol reference only** | Pinned repository commit `4c972f82b51988d94c8f7b7d6b56bb5338c9be7f`; SDK/code license not cleared or relied upon; no code copied | Typed event-stream patterns inform an optional edge adapter only. Verify exact protocol version, draft features, transport, and code license before implementation or SDK use. See `research docs/architecture-evolution-review-2026-09.md` and `docs/research/SOURCE-TRACEABILITY.md` `U-AG-UI`. |
| `SRC-045` | cargo-deny license policy and GitHub Action | **CI tool** | `cargo-deny` and `cargo-deny-action` are Apache-2.0 OR MIT at pinned action commit [`3c6349835b2b7b196a839186cb8b78e02f7b5f25`](https://github.com/EmbarkStudios/cargo-deny-action/tree/3c6349835b2b7b196a839186cb8b78e02f7b5f25); used only in CI, not linked or shipped | `deny.toml` enforces an explicit SPDX allowlist; a crate/version-specific exception handles the locked CDLA-Permissive-2.0 data package. CI includes distinct GPL-3.0-only and missing-license local dependency controls. See [`U-CARGO-DENY`](SOURCE-TRACEABILITY.md#u-cargo-deny) and AX-001. |
| `SRC-046` | Rust `ignore` walker | **Depend** | `ignore` 0.4.33 declares `Unlicense OR MIT`, both permitted by the checked-in license policy; the exact crate source/version is pinned in `Cargo.toml` and `Cargo.lock` | Workspace-local ignore-file parsing, ordered traversal, and pre-descent filtering for AX-004. The dependency is used as a library; no upstream source is copied. See [`U-RIPGREP-IGNORE`](SOURCE-TRACEABILITY.md#u-ripgrep-ignore) and [the 2026-10-01 API review](../../research%20docs/ignore-crate-review-2026-10-01.md). |

## 3. Hard no-go

Never link, copy, or vendor: any copyleft (GPL/AGPL) project, any non-OSI/source-available TUI, any restricted-dual-license `enterprise`/`ee` subtree, any repository with no or empty license, and any closed product (patterns and interfaces only).

**Pattern reuse is not code reuse.** Research notes may inspire behavior and record
trade-offs, but source code, generated schemas, tests, fixtures, documentation, and
assets are separate copyright/licensing surfaces. Before adapting material, pin the
exact repository revision and path, inspect the applicable license and notices, check
compatibility with the intended distribution, record modifications, and obtain review
under `AX-001`/`AX-010`. Do not infer a license from a repository badge or copy across a
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

**Notice-bundle source status (2026-09-28; dependency-license gate status 2026-10-01).** The bundle and its gate are implemented
(`AX-010`). `horizoncode notices generate` renders `THIRD-PARTY-NOTICES.md` from
the pinned `Cargo.lock` and from the license/notice files of the package sources
that are present for the generating platform: each registry package's `license`
expression and its verbatim `LICENSE`/`COPYING`/`NOTICE`/`UNLICENSE` documents,
deduplicated per expression. Packages whose sources are absent (built for another
target platform) are listed explicitly under *not resolved on the generating
platform* rather than omitted. The bundle is embedded in the binary and printed
by `horizoncode --credits`, which needs no store, provider, or environment. The
separate dependency-license allowlist and its synthetic negative control are now
implemented in `deny.toml` and `.github/workflows/ci.yml` under AX-001; CI execution
and the `ACC-DEP-01` acceptance record remain outstanding until the workflow runs on
an integrated revision.

`horizoncode notices check` and the unit gate apply three rules instead of byte
equality, because which sources are unpacked varies by machine: the lockfile
digest named in the bundle must match `Cargo.lock`; every locked package must
appear in the bundle and nothing may appear that is not in the lock graph; and
every package whose source is present locally must appear in the resolved table
with its shipped license expression and all of its notice texts. A locally built
package can therefore never be hidden in the unresolved section or lose its
notice. This notice check does not validate dependency licenses or in-tree
provenance records for `Adapt`/`Vendor` rows; license enforcement is owned by
`deny.toml`/CI, and no `Adapt`/`Vendor` provenance entries currently exist.

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

## License clarification from the final audit

System Git must not be described as permissively licensed. Its official
[COPYING](https://github.com/git/git/blob/master/COPYING), checked 2026-09-30,
contains GPLv2 terms. Invoking a separately installed Git executable is a different
adoption/distribution choice from copying, bundling, or linking its implementation.
Each selected library/package and redistributed component requires its own clearance
and notices; SRC-014 is not blanket clearance for every Git implementation.
No upstream code, schema, tests, or assets were copied in this audit.

## Interaction research additions (2026-09-30)

| ID | Source | Disposition |
|---|---|---|
| SRC-042 | DeepSeek Harness, pin639ed015397290b3745d163aafe02ffee4aa3f84; ARCH29 U-DSH rows | Design influence from actual scheduler/PTC/compaction/workflow source; no code copied |
| SRC-043 | OpenCode composer pin9b4882db54627f2656a6990daafa412f9f3c7c82 and official TUI/theme/keybind docs | Interaction research; no code/assets copied; exact paths in ARCH29 |
| SRC-044 | litePSM sibling architecture snapshot in ARCH29 U-LITEPSM-ARCH | Integration design dependency, not a runtime/security/implementation endorsement |
