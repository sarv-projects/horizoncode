# 04 — Decisions

Architecture decision records. Each constrains the design until superseded by a later `DEC-*`.

## DEC-001 — Hybrid sourcing: own the control plane, vendor the leaves

**Status:** accepted.

**Decision.** Reimplement the differentiating layers first-party; depend on narrow, permissively licensed libraries for solved chores; take patterns only (no code) from anything copyleft, source-available, dual-licensed-with-restrictions, or unlicensed; integrate other agents and external tooling only across protocol boundaries.

**Moat (first-party):** runner/loop, policy guard, audit, context/compaction, routing + eval, orchestration/merge.

**Leaves (dependencies):** protocol SDKs, sandbox crates, tree-sitter/LSP/SCIP, git/sqlite/clap, TUI rendering, hashing, WASM.

**Rationale.** The harness is commoditized; vendoring a peer's core buys weeks and taxes forever, while a from-scratch rewrite rebuilds undifferentiated plumbing. The hybrid maximizes velocity on commodities while keeping sovereignty over the differentiators.

**Consequences.** A freeze table (`ARCH/05`) is architecture; a layer marked as a dependency may not be hand-rolled without a written exception. The "patterns only, never vendor" doctrine is retained for the moat and relaxed for leaves.

## DEC-002 — Language: Rust monolith, single binary

**Status:** accepted.

**Decision.** Rust workspace producing one binary. TUI in Rust. No second runtime in the core. TypeScript permitted only as an *edge* SDK that talks to the binary over stdio.

**Rationale.** A standalone binary is a product requirement; sandboxing is syscall-shaped; the official ACP/MCP SDKs are strong on Rust; the moat layers are concurrency- and cancellation-heavy. A dual-runtime design (scripting-host brain + native core) would add a second state model, a native build matrix, and FFI risk.

**Consequences.** The installer must check for a build toolchain (`REQ-VISION-002`). Rejected alternative: native core + scripted/React TUI.

## DEC-003 — ACP-native, protocol-first

**Status:** accepted.

**Decision.** Implement ACP as a first-class stdio server and, later, an ACP client. Implement MCP as a host. The core never depends on ACP/MCP specifics; adapters map them onto the control interface.

**Rationale.** Editor-neutral integration and peer-agent interoperability without a second engine (`REQ-PROTO-005`).

## DEC-004 — Durable, event-sourced sessions

**Status:** accepted.

**Decision.** Sessions are event-sourced: an append-only log is the source of truth; SQLite holds derived state and indexes. Sessions are replayable and resumable; checkpoints and rewind operate on the log.

**Rationale.** Long-horizon work requires surviving crash and restart with no state loss (`REQ-SESS-001`, `REQ-LOOP-006`, `REQ-HORIZON-001`).

## DEC-005 — Fail-closed policy guard and tamper-evident audit

**Status:** accepted.

**Decision.** Permissions are ordered rules yielding allow/ask/deny with a fail-closed default. "Always allow" persists the exact remembered pattern. Every security-relevant effect appends to a hash-chained audit log with a verification command.

**Rationale.** Deterministic, inspectable authority plus verifiable history is a differentiator no leading peer ships (`REQ-GUARD-001..004`, `REQ-AUDIT-001..003`).

## DEC-006 — Context engine with evaluation-gated compaction

**Status:** accepted.

**Decision.** Maintain a ranked repository map (parsed definitions + reference graph), LSP symbols, and indexed navigation. Compaction preserves a serialized tail plus a structured summary and is gated by retrieval evaluation, not just window fit.

**Rationale.** Context survival at scale is a stated differentiator (`REQ-CTX-001..005`).

## DEC-007 — Data-driven provider catalog, external source of truth

**Status:** accepted.

**Decision.** Consume provider/model metadata from an external catalog at runtime (cached, refreshed, snapshotted for offline), rather than vendoring a registry. Model routing is policy-configurable and may be eval-gated.

**Rationale.** Keeps the catalog current and avoids maintaining hundreds of models; provider parity with the field (`REQ-PROV-001..005`).

## DEC-008 — Tiered sandbox behind one interface

**Status:** accepted.

**Decision.** Local confinement via bubblewrap + Landlock + seccomp (network off, workspace-only writes) by default; container, micro-VM, and remote tiers behind one `SandboxProvider` interface; bubblewrap is invoked as a subprocess (never linked).

**Rationale.** Strong default safety without a copyleft link, with an escape hatch for hostile workloads (`REQ-GUARD-004`).

## DEC-009 — Durable long-horizon task graph

**Status:** accepted.

**Decision.** Maintain a durable task graph that survives compaction and restart, distinct from the ephemeral todo list. Budgets (tokens, cost, wall-clock) are enforceable and fail closed.

**Rationale.** This is the product's central claim: work that runs for hours (`REQ-HORIZON-001..004`).

## DEC-010 — Worktree cockpit as a dockable pane with an embedded editor

**Status:** accepted.

**Decision.** The primary interface is scrollback-native with a fixed composer dock. The worktree cockpit is a **dockable, extensible pane** (dock to a side, collapse/expand, remove, restore, top-right toggles) showing the indexed worktree, file viewing, colored diffs, and in-terminal editing via an **embedded mini-editor** (open/edit/save/undo + syntax highlight; no IDE features). Telemetry and server status move behind a command/palette surface.

**Rationale.** The cockpit is the user's persistent state-of-the-world during long runs; per-request telemetry belongs on demand, not permanently on screen (`REQ-UI-005..006`).

## DEC-011 — Vendor-neutral naming

**Status:** accepted.

**Decision.** No vendor, competitor, or assistant brand names in source, commits, help text, or shipped documentation. Upstream dependencies are cited by role and license. This rule **explicitly exempts mandatory legal attribution**: copyright lines, license texts, `NOTICE`/`THIRD-PARTY-NOTICES` content, and provenance headers that an upstream license requires MUST be reproduced where the license demands it, and MUST NOT be stripped or paraphrased to satisfy brand-neutrality. The exemption is limited to what a license legally requires — vendors' internal or unreleased *code names*, and optional marketing names, remain excluded. `THIRD-PARTY-NOTICES.md` is generated at release and shipped with the binary.

**Rationale.** Clean-room posture and trademark hygiene (`REQ-VISION-003`).

## DEC-012 — License allowlist enforced in CI

**Status:** accepted.

**Decision.** A dependency allowlist (permissive SPDX set only) is enforced by an automated check that fails the build on any violation. Adapted files carry a provenance header (upstream role, pinned revision, license, changes). Copyleft, source-available, restricted-dual-license, and unlicensed code is a hard no-go.

**Rationale.** One contaminated file poisons the distribution irreversibly (`REQ-SEC-001`).

## DEC-013 — Adopt the observation-compression pattern, not the tool

**Status:** accepted.

**Decision.** Implement **native, deterministic per-command output formatters** (filtering, grouping, truncation, deduplication) plus a full-output **recall store**, per command family, **eval-gated**. Do **not** depend on any external output-filter binary, and never present a compressor-internal counter as a saving.

**Rationale.** Investigated directly (`ARCH/19`). The named approach is well engineered but two independent paired benchmarks found no per-task cost reduction (parity at best, increases elsewhere) with task quality tied, because little input flows through the compressible channel and cached re-reads dominate cost. The *pattern* is sound and client-side; the tool and its self-reported metric are not evidence.

## DEC-014 — Prompt caching is a first-class context concern

**Status:** accepted.

**Decision.** Order context as tools → system → messages with an explicit cache breakpoint at the end of static content, never mutate the cached prefix mid-run, and treat the cache-read/creation/input token triple as the primary compression metric.

**Rationale.** It is the only provider-exposed form of KV reuse and the largest proven cost lever for a remote-API agent (`REQ-CTX-007`).

## DEC-015 — Extractive for code, schema-bound abstractive for prose

**Status:** accepted.

**Decision.** Code and tool observations are compressed by **selection/grouping** (verbatim spans) or not at all; abstractive summarization is reserved for prose and must follow a structured schema (decisions / open bugs with exact errors / file refs / next step / discarded-and-where-to-recover).

**Rationale.** Rewording code or logs destroys identifiers, hashes, and negations; extraction preserves them (`REQ-CTX-008`, `REQ-CTX-003`).

## DEC-016 — Compression is judged by paired task evals, never by internal counters

**Status:** accepted.

**Decision.** Every compression change ships only if a **paired per-task A/B** (k ≥ 3, pre-registered endpoints) shows task success ≥ baseline and cost/turn improved; results are reported as per-task median + pass-rate deltas, not totals. Compressor-internal "saved" counters are explicitly not evidence.

**Sequencing.** The pairing/eval harness is a prerequisite, not a follow-up: it MUST be built and working **before** the eval-gated features it judges are built or shipped. A gate that cannot be run at the moment a feature lands is not a gate (`TODO.md` `AX-307`, pulled ahead of the P2 gated features).

**Rationale.** Both cited benchmarks were decided by this methodology; self-reported savings systematically overcount (`REQ-CTX-009`).

## DEC-017 — Analytics is local-first and separate from product telemetry

**Status:** accepted.

**Decision.** Usage/cost/tool/session/reliability/routing metrics are recorded to a local, rebuildable ledger and served by local commands; the analytics path makes no network egress. Any remote export is explicit opt-in and sanitized. Engineering analytics are kept distinct from product/usage analytics.

**Rationale.** Long-horizon work must be inspectable without leaking code or prompts, and "proper" numbers (observed vs estimated, pinned pricing) are impossible to trust if they are mixed with adoption metrics (`REQ-ANALYTICS-001..006`).

## DEC-018 — Extensions are deny-by-default and provenance-pinned

**Status:** accepted.

**Decision.** MCP servers, skills, and plugins are discovered but not used until explicitly enabled; externally sourced artifacts are pinned by version/hash and their provenance is shown; plugin/hook effects pass through the guard; untrusted processes run sandboxed; a managed lockdown can restrict them. No external registry's trust policy is inherited.

**Rationale.** Discovery is not trust; a coding agent with filesystem and network reach is a high-value target for a malicious skill, plugin, or server (`REQ-SKILL-001..004`, `REQ-PLUGIN-001..004`, `REQ-PROTO-003`).

## DEC-019 — ACP both directions are first-class

**Status:** accepted.

**Decision.** agentX implements ACP as a first-class **server** (usable by clients) and a first-class **client** (driving peer agents as subordinates) with equal standing. This supersedes the "later" qualifier in `DEC-003`. Capability negotiation gates every optional call in both roles.

**Rationale.** Being both usable and composable is a stated product priority and the seam that lets agentX orchestrate peers without a second engine (`REQ-PROTO-004`, `REQ-PROTO-006`).

## DEC-020 — Multiple append-only stores under one cross-store invariant

**Status:** accepted.

**Decision.** Keep **separate** append-only stores, each owned by exactly one component, rather than collapsing them into a single log: the session event log (`CMP-session`; replay source of truth), the tamper-evident audit chain (`CMP-audit`; independently verifiable evidence), and the analytics ledger (`CMP-analytics`; rebuildable rollup source). Each store owns its own ordering and retention. Where one effect appears in more than one store, the stores MUST satisfy a **cross-store consistency invariant**: a security-relevant effect is complete only once its audit entry is durably chained, and every session/analytics fact that references it carries the owning `session_id`, its monotonic session `seq`, and the audit `seq` (or `receipt_ref`). Ordering is defined by each store's own monotonic sequence; **cross-store ordering is never inferred from wall-clock time** — the audit `seq` is the authoritative tie-break for security-relevant ordering, and a reconciliation check flags any referenced effect that has no audit entry. Retention stays per-store: the audit chain is never pruned with the session log or the analytics ledger.

**Rationale.** A single store would couple replay, tamper-evidence, and derived metrics: an analytics retention choice could put the audit chain at risk, and a corrupt session log could poison evidence. Separate stores keep each guarantee provable while an explicit invariant stops them drifting into disagreement (`REQ-AUDIT-001`, `REQ-AUDIT-006`, `DEC-004`, `DEC-005`, `DEC-017`; detail in `ARCH/14`).
