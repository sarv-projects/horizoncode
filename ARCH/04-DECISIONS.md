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

**Decision.** No vendor, competitor, or assistant brand names in source, commits, help text, or shipped documentation. Upstream dependencies are cited by role and license; legally required attribution is generated into `THIRD-PARTY-NOTICES.md` at release.

**Rationale.** Clean-room posture and trademark hygiene (`REQ-VISION-003`).

## DEC-012 — License allowlist enforced in CI

**Status:** accepted.

**Decision.** A dependency allowlist (permissive SPDX set only) is enforced by an automated check that fails the build on any violation. Adapted files carry a provenance header (upstream role, pinned revision, license, changes). Copyleft, source-available, restricted-dual-license, and unlicensed code is a hard no-go.

**Rationale.** One contaminated file poisons the distribution irreversibly (`REQ-SEC-001`).
