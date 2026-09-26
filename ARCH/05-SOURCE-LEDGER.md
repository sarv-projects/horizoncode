# 05 — Source Ledger

What agentX **builds**, **vendors**, or only **draws patterns from**. Identities are by role per the vendor-neutral rule (`DEC-011`); the concrete upstream mapping is recorded in the non-shipped research archive. Attribution that a license requires is generated into `THIRD-PARTY-NOTICES.md` at release.

Legend: **Build** = first-party code · **Depend** = consume a library/SDK · **Pattern** = study only, no code · **Data** = consume data, not code · **Avoid** = never link, copy, or vendor.

## 1. Disposition by layer

| Layer | Disposition | Source role | License |
|---|---|---|---|
| Agent loop & scheduler | **Build** | Pattern from two Rust agent CLIs + one TS harness | pattern only |
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

Reference entries are indexed by role. Concrete upstream identity is intentionally omitted from shipped docs (`DEC-011`); each row below is backed by a `/home/sarvesh/business_Dev/REPO-COMPARE/` clone or a public URL recorded in the research archive.

| ID | Role | Disposition | License | What we take |
|---|---|---|---|---|
| `SRC-001` | Primary TS reference harness ("base" for logic/HLD/LLD) | **Pattern** | MIT | Loop shape, tool registry + permission materialization, compaction budgets, provider catalog approach, ACP mapping, headless CLI shape |
| `SRC-002` | Rust agent CLI (control plane) | **Pattern** | Apache-2.0 | Turn/steer model, OS sandbox types, policy-as-data + amendment-with-scope, app-server protocol v2, approval taxonomy, secret-env filtering |
| `SRC-003` | Rust TUI agent | **Pattern** | Apache-2.0 | ratatui TUI structure, checkpoint/rewind, sandbox profile matrix, folder-trust gate, goal subsystem, two-pass compaction |
| `SRC-004` | Plugin-kernel agent runtime | **Pattern** | MIT | Profile/bundle/patch composition, waterfall taxonomy, guarded sub-call, migration discipline |
| `SRC-005` | Editor-embedded agent | **Pattern** | Apache-2.0 | MCP hub (transports, OAuth, debounce/dedupe), plan/act guard, checkpoint/restore transactions, retry guards |
| `SRC-006` | Multi-provider gateway | **Pattern** | MIT (core); restricted `enterprise/` subtree = **Avoid** | Routing strategy shapes, typed fallback, cooldown, budget gates |
| `SRC-007` | Minimal TS coding agent | **Pattern** | MIT | Provider-quirk isolation, cross-provider context handoff, abort-everywhere, split tool results, scrollback-native differential rendering |
| `SRC-008` | Repo-map ranking | **Adapt** | Apache-2.0 | Tree-sitter tag graph + PageRank ranking (provenance header required) |
| `SRC-009` | Model catalog dataset + client | **Data** | MIT | Provider/model metadata consumed at runtime; snapshot for offline |
| `SRC-010` | ACP protocol SDK | **Depend** | Apache-2.0 | JSON-RPC stdio transport + schema |
| `SRC-011` | MCP protocol SDK | **Depend** | MIT/Apache-2.0 | Host-side client, stdio + streamable HTTP |
| `SRC-012` | Sandbox crates | **Depend** | MIT/Apache-2.0 | Landlock bindings, seccomp bindings; bubblewrap invoked as subprocess |
| `SRC-013` | Parser / LSP / index | **Depend** | MIT / Apache-2.0 | tree-sitter, LSP client, SCIP ingest |
| `SRC-014` | Git / DB / CLI / TUI / hash / WASM | **Depend** | permissive | gitoxide, rusqlite, clap, ratatui, crossterm, blake3, wasmtime |

## 3. Hard no-go

Never link, copy, or vendor: any copyleft (GPL/AGPL) project, any non-OSI/source-available TUI, any restricted-dual-license `enterprise`/`ee` subtree, any repository with no or empty license, and any closed product (patterns and interfaces only).

## 4. Enforcement

- Dependency allowlist check runs in CI; a violation fails the build (`DEC-012`).
- Adapted files carry a provenance header: source role, pinned revision, license, and what changed.
- `THIRD-PARTY-NOTICES.md` is generated at release from the resolved dependency graph.
