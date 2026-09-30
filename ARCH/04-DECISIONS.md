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

**Decision.** HorizonCode Thread conversations are event-sourced: an append-only log is the source of truth; SQLite holds derived state and indexes. Threads are replayable and resumable; checkpoints and rewind operate on the log. `CMP-session` remains the persistence component name for compatibility, while protocol/provider Sessions are external bindings.

**Rationale.** Long-horizon work requires surviving crash and restart with no state loss (`REQ-SESS-001`, `REQ-LOOP-006`, `REQ-HORIZON-001`).

## DEC-005 — Fail-closed policy guard and tamper-evident audit

**Status:** accepted.

**Decision.** Permissions are ordered rules yielding allow/ask/deny with a fail-closed default. "Always allow" persists the exact remembered pattern. Every security-relevant effect appends to a hash-chained audit log with a verification command.

**Rationale.** Deterministic, inspectable authority plus verifiable history is a product requirement (`REQ-GUARD-001..004`, `REQ-AUDIT-001..003`). Comparative claims require a dated benchmark or capability matrix; this ADR makes no claim about peer coverage.

## DEC-006 — Context engine with evaluation-gated compaction

**Status:** accepted.

**Decision.** Maintain a ranked repository map (parsed definitions + reference graph), LSP symbols, and indexed navigation. Automatic compaction is enabled by default and uses a configurable context-window utilization threshold, defaulting to 50% of the active route's resolved model window; it preserves a serialized tail plus a structured summary and is gated by retrieval evaluation, not just window fit. The output/buffer/estimation-uncertainty reserve remains an independent hard fit guard. Setting automatic compaction off disables every automatic compaction path, including pre-send threshold compaction and reactive overflow/truncation recovery. The hard fit guard still refuses an oversized request with `CONTEXT_TOO_LARGE` guidance; it never dispatches the request or silently compacts. Explicit manual compaction remains available independently.

**Rationale.** Context survival at scale is a stated differentiator (`REQ-CTX-001..005`).

## DEC-007 — Curated data-driven provider catalog (refined by DEC-021)

**Status:** accepted.

**Decision.** Use a small curated provider/model primary with row-level provenance, and permit explicit opt-in runtime enrichment; do not bundle the full upstream catalog or third-party marks by default. `DEC-021` is the current source/license and catalog-posture decision. Model routing is policy-configurable and may be eval-gated.

**Rationale.** Maintains offline determinism while allowing opt-in freshness; catalog breadth is not a quality guarantee (`REQ-PROV-001..005`).

## DEC-008 — Tiered sandbox behind one interface

**Status:** accepted.

**Decision.** The target local confinement is workspace-scoped with a request for no network; bubblewrap is invoked as a subprocess (never linked). Landlock/seccomp are additional target mechanisms only when implemented and accepted. Container, micro-VM, and remote tiers sit behind one `SandboxProvider` interface. Current implementation evidence is recorded by `DEC-037`.

**Rationale.** Strong default safety without a copyleft link, with an escape hatch for hostile workloads (`REQ-GUARD-004`).

## DEC-009 — Durable long-horizon task graph

**Status:** accepted.

**Decision.** Maintain a durable task graph that survives compaction and restart, distinct from the ephemeral todo list. Budgets (tokens, cost, wall-clock) are enforceable and fail closed.

**Rationale.** This is the product's central claim: work that runs for hours (`REQ-HORIZON-001..004`).

## DEC-010 — Worktree cockpit as a dockable pane with an embedded editor

**Status:** accepted for bounded editor scope; the original scrollback-first and freely dockable layout is superseded by `DEC-066`.

**Historical decision, amended by DEC-074 (2026-09-29).** This record originally scoped a bounded embedded editor for open/edit/save/undo and syntax highlighting. Normal source editing now uses the user's native editor through the governed bridge; a general in-terminal editor is not a v1 dependency. The Explorer, read-only viewer, and diff remain in the left dock. Its original primary-interface and free-docking language is historical; `DEC-066` controls pane positions. Telemetry and server status move behind a command/palette surface.

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

**Decision.** Produce a deterministic, versioned internal context projection; each provider adapter renders the order and cache controls required by its wire API. Where supported, pin the static serialized prefix within a context epoch and record cache-read/creation/input usage separately. Do not assume every provider supports prompt caching or reports the same usage classes.

**Rationale.** Stable serialization permits providers that support prefix caching to reuse content without forcing one wire shape on every API. Cache savings remain provider-specific and must be measured (`REQ-CTX-007`).

## DEC-015 — Extractive for code, schema-bound abstractive for prose

**Status:** accepted.

**Decision.** Code and tool observations are compressed by **selection/grouping** (verbatim spans) or not at all; abstractive summarization is reserved for prose and must follow a structured schema (decisions / open bugs with exact errors / file refs / next step / discarded-and-where-to-recover).

**Rationale.** Rewording code or logs destroys identifiers, hashes, and negations; extraction preserves them (`REQ-CTX-008`, `REQ-CTX-003`).

## DEC-016 — Compression is judged by paired task evals, never by internal counters

**Status:** accepted.

**Decision.** Every compression change is evaluated by a paired per-task A/B with pre-registered sample size and endpoints; three paired runs are smoke evidence only. Report task success, all per-task outcomes, cost/turn, latency, recall, and uncertainty. Output-byte reduction and compressor-internal "saved" counters are not cost evidence.

**Sequencing.** The pairing/eval harness is a prerequisite, not a follow-up: it MUST be built and working **before** the eval-gated features it judges are built or shipped. A gate that cannot be run at the moment a feature lands is not a gate (`TODO.md` `AX-307`, pulled ahead of the P2 gated features).

**Rationale.** The method prevents a reduction in one output channel from being mistaken for a task-level cost improvement (`REQ-CTX-009`).

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

**Decision.** HorizonCode implements ACP as a first-class **server** (usable by clients) and a first-class **client** (driving peer agents as subordinates) with equal standing. This supersedes the "later" qualifier in `DEC-003`. Capability negotiation gates every optional call in both roles.

**Rationale.** Being both usable and composable is a stated product priority and the seam that lets HorizonCode orchestrate peers without a second engine (`REQ-PROTO-004`, `REQ-PROTO-006`).

## DEC-020 — Multiple append-only stores under one cross-store invariant

**Status:** accepted.

**Decision.** Keep **separate** append-only stores, each owned by exactly one component, rather than collapsing them into a single log: the Thread event log (`CMP-session`; replay source of truth), the tamper-evident audit chain (`CMP-audit`; independently verifiable evidence), and the analytics ledger (`CMP-analytics`; a durable but rebuildable projection, never execution truth). Each store owns its own ordering and retention. Where one effect appears in more than one store, the stores MUST satisfy a **cross-store consistency invariant**: a security-relevant effect is complete only once its audit entry is durably chained, and every cross-store reference carries owner-qualified aggregate identity/sequence, event ID, schema version, and payload digest (`DurableFactRef` in `ARCH/14`). References to security-relevant effects include the Thread `seq` and audit `audit_seq` (or stable receipt reference). Ordering is defined by each store's own monotonic sequence; **cross-store ordering is never inferred from wall-clock time** — `audit_seq` is authoritative for security-relevant order, and reconciliation flags missing or mismatched references. An analytics projection is rebuilt only from validated canonical owner facts and reports incomplete source coverage rather than silently fabricating totals. Retention stays per-store: the audit chain is never destructively pruned with the Thread log or analytics projection; archived audit ranges retain verifiable references (`DEC-044`).

**Rationale.** A single store would couple replay, tamper-evidence, and derived metrics: an analytics retention choice could put the audit chain at risk, and a corrupt Thread log could poison evidence. Separate stores keep each guarantee provable while an explicit invariant stops them drifting into disagreement (`REQ-AUDIT-001`, `REQ-AUDIT-006`, `DEC-004`, `DEC-005`, `DEC-017`; detail in `ARCH/14`).

## DEC-021 — Model catalog posture: curated primary, opt-in enrichment, no bundled marks (refined by DEC-060)

**Status:** accepted. Closes the `SRC-009` data-license hard gate.

**Decision.**

1. **The built-in catalog is a small, internally curated subset** covering only the providers and models HorizonCode actually supports. Every row carries provenance: source URL, retrieval date, generating method or script, and a pinned upstream commit wherever a value is derived. Limits and pricing are verified against provider-published documentation and cross-checked against a second permissively licensed community map.
2. **Generic runtime enrichment is opt-in.** With network permission, a generic catalog source MAY be refreshed through an explicit command, with timeout, schema validation, and offline-by-default behavior. The cache records source URL, retrieval timestamp, content hash, and upstream commit when known. Live data **MUST NOT** silently overwrite pinned eval fixtures. The OpenCode-specific default refresh is the scoped exception in `DEC-060`.
3. **No full dataset snapshot in the binary by default.** The grant permits it with the notice retained, but it is rejected as the default posture: it imports daily staleness, community-data accuracy liability that upstream explicitly disclaims, and binary bloat — for no compliance benefit over (1) + (2).
4. **No third-party marks are bundled.** Provider and model names appear as plain text (nominative use). Provider logos are NOT redistributed: the upstream grant conveys no trademark rights. Names MUST stay factually accurate and MUST NOT imply endorsement.
5. **Attribution is unconditional.** Any bundled or derived catalog data ships the upstream copyright line and full permission notice through `THIRD-PARTY-NOTICES` and a `--credits` / `about` surface, satisfying the MIT notice condition for every row regardless of which tier supplied it.

**Rationale.** The grant is permissive and verified from primary sources, so redistribution is legally available subject to notice retention. Operational risk remains: a pseudonymous holder, no contributor agreement, unaddressed database rights, and no accuracy warranty. A small verified primary keeps offline resolution and eval reproducibility; generic opt-in enrichment adds breadth without making correctness depend on it. OpenCode's live registry is added only as a bounded data-only source under `DEC-060`. Excluding marks avoids assuming trademark rights (`SRC-009`, `DEC-011`, `AX-010`, `REQ-PROV-*`; detail in `ARCH/05` §5 and `ARCH/11`).

**Residual risk (accepted).** Upstream title to every byte of a community-curated dataset is not fully provable from public sources; no contributor agreement exists upstream; EU sui generis database rights are not addressed by the grant; upstream disclaims accuracy entirely, so pricing and limit errors are our operational liability. Mitigation is the per-row provenance record plus cross-verification — not a stronger license claim.

## DEC-022 — Audit root authentication, declared anchoring level, and honest claim boundary

**Status:** accepted; amended 2026-09-28 after source recheck. Resolves `ARCH/22` Open question 1 and `ARCH/14` Open question 1. Original “signed roots” wording overstated the implementation: current source uses a local BLAKE3 keyed MAC, with `device.key` under the audit store; it is not an asymmetric signature and is not owned by `CMP-secrets`.

**Decision.**

1. **Root authentication is not configurable off.** Its algorithm and key owner are
   explicit. The current BLAKE3 keyed MAC supports local verification only. Any
   portable/off-box authenticity claim requires independently verifiable public-key
   proof or trusted counter-signing and a separate key-custody/rotation design.
   `audit.anchor.authentication: none` is a configuration error, not a supported
   posture. Do not call a shared-secret MAC a public-key signature.
2. **Three declared anchoring levels, default `local-sink`** (table below).
3. **A configured-but-unreachable sink fails closed.** The evidence gate fails and
   the run does not degrade to a weaker level presented as the configured one
   (`REQ-AUDIT-007`, `REQ-SEC-024`).
4. **The claim boundary is stated, not implied.** Tamper-evidence covers modification
   of *already-anchored* history by a principal that does not hold the anchoring
   credential. It is not content authenticity, not fabrication by a principal with
   local (and, for `local-sink`, sink-write) access, and not entries written after the
   last anchored root. `local-sink` is never presented as `off-box`.

| Level | `anchor.offbox` | Claim |
|---|---|---|
| `local-trust` | `none` | locally authenticated roots only in the audit store; no independent verification claim. Permitted only as an explicit, acknowledged posture and labeled everywhere. |
| `local-sink` (**target default**) | `file` | locally authenticated roots appended to a distinct, ownership- and mode-validated append-only sink **outside** `<state-dir>/audit`; claims are bounded by access to both key and sink. |
| `off-box` | `remote` | roots with independently verifiable proof recorded off-host or counter-signed; required for any deployment that declares an off-box trust requirement. |

**Rationale.** The earlier wording of `REQ-AUDIT-004` said every deployment required
authenticated off-box anchoring, while `ARCH/14` defaulted to no sink. The accepted
requirement is now explicitly scoped: `local-sink` is the target default, `local-trust`
requires explicit acknowledgement, and `off-box` is mandatory when a deployment
declares that trust requirement. A fresh install cannot invent a remote sink, so the
local sink is the strongest default that needs no external party. It defends against
audit-store-local rewriting and against a *different* unprivileged principal (`AV-6`),
which are the in-scope adversaries for that level; `off-box` is reserved for a claim
that survives against the invoking user (out of scope per the threat model, but a
deployment may still require it). This is a scope distinction recorded in the
requirement, not a universal off-box guarantee. A chain — even anchored — proves
detection of modification of already-anchored history, never content authenticity, and
never detects fabrication in the unanchored tail.

**Consequences.** `"offbox": "file"` replaces `"none"` as the shipped default
(`ARCH/14` §Configuration), with `sink_path` validated per `REQ-SEC-018` and a
`trust_requirement` key (`none` | `off_box`); `"none"` continues to work but must carry
an explicit `local-trust` acknowledgement. Root authentication once and only once is
the contract, so `authentication: none` is rejected at load. A deployment that declares `trust_requirement:
off_box` and configures a weaker `anchor.offbox` is refused. The acceptance record
stores the **level** and, for `local-trust`/`local-sink`, the rendered claim boundary.

**Governs:** `REQ-AUDIT-004`, `REQ-AUDIT-007`, `REQ-SEC-024`; evidence in
`ACC-P1-04` and gate `G-5`; residual risks `RR-02`, `RR-03`, and threat rows `D-01`,
`D-02`. Detail in `ARCH/14`; tracked by `TODO.md` `AX-117`.

## DEC-023 — The canonical ACP permission method token is `session/request_permission`

**Status:** accepted. Resolves `ARCH/22` Open question 2 and the `TODO.md` protocol-naming
open decision.

**Decision.** The wire token for the ACP client permission request is exactly
**`session/request_permission`**. It is **frozen**: no alias is accepted, and
`request/permission` is not recognized as a transition form in either direction. One
method, one token, one entry in the protocol table.

**Rationale.** The implementation, the pinned ACP SDK, and the existing end-to-end test
already use `session/request_permission`, and `ACC-P1-03` is specified against it.
`ARCH/15`'s `request/permission` row was a single documentation error, so the correct
resolution is to fix the document, not to widen the protocol. Accepting both would create
a second method identity — the opposite of one typed vocabulary and of
`REQ-PROTO-006` capability gating, and a second identity is exactly the class of drift the
capability gate exists to prevent.

**Consequences.** The `ARCH/15` method matrix carries only the canonical token. A peer that
sends or advertises the unnamespaced form receives a typed unknown-method error; there is
no compatibility shim to retire later. `ARCH/23` `ACC-P1-03` and `ACC-P1-05` already
specify the canonical token and are unchanged.

**Governs:** `REQ-PROTO-002`; evidence in `ACC-P1-03`, `ACC-P1-05`. Detail in `ARCH/15`
§Data / state model.

## DEC-024 — Shell-argument path scanning is an escalation signal; spawn-time confinement is the control

**Status:** accepted. Resolves the `ARCH/10` / `REQ-SEC-003` reconciliation (part of
`ARCH/22` Open question 3).

**Decision.** A lexical scan of a shell command's arguments is a **resource-extraction and
escalation signal only**. It may raise an `ask` or a `deny`; it may never lower one, and it
is never the sole control. The hard target control for a spawned command is
**spawn-time confinement**: the selected backend applies the resolved profile's scoped
roots and deny set to its actual process boundary. The exact filesystem and network
mechanism and residual are per-tier; this decision does not claim every backend uses
kernel-enforced glob evaluation or confines every descendant (`DEC-037`). Specifically:

- a `bash` command naming a path outside the workspace is **asked** by default, through
  the existing `external_directory` approval;
- a path matching a deny glob or a protected subpath is **denied**;
- a tier that cannot actually confine the reach **refuses (fails closed)**.

"Allowed-with-warning" is never the sole control for a spawned path target.

**Rationale.** `REQ-SEC-003` ("targets MUST be validated against policy before use") and
`ARCH/10` ("advisory only") do not actually contradict once the layers are named: for a
*spawned* process the only sound validation is at the enforcement boundary, because a shell
re-parses its arguments and a lexical scan cannot be sound (`ARCH/22` `E-03`, `RR-10`).
Calling the scan "advisory" without naming the hard control left `REQ-SEC-003`
aspirational. The hard boundary is mechanism-specific: spawned children use the
selected OS backend; in-process file operations use handle-relative/no-follow APIs and
revalidation where the platform provides them. `REQ-SEC-005` does not claim a universal
kernel boundary or equivalent containment across all tiers. "Asked" rather than
"denied" preserves the documented `external_directory` capability while the selected
enforcement path bounds reach to its declared, tested level (`REQ-SEC-010`: authorization
is not reach; `DEC-045`).

**Consequences.** `external_directory` becomes a built-in floor rule with effect `ask`
(overridable toward `deny`, never to a silent allow). The tool plane extracts
path-shaped arguments as additional `fs.*` resources on the guard request
(`crates/horizoncode-tools/src/registry.rs` `resources_from_input`,
`crates/horizoncode-tools/src/path.rs` are the future implementation touchpoints) rather than
judging them. `audit verify` and the guard decision table record the combined decision.
An acceptance assertion covers the deny/ask/refuse split per tier, including per-tier read
scoping.

**Governs:** `REQ-SEC-003`, `REQ-SEC-005`, `REQ-SEC-010`, `REQ-SEC-025`; evidence in
`ACC-P1-01` and `ACC-P1-02`. Detail in `ARCH/10` §Built-in tool set, `ARCH/12`, and
`ARCH/13`. Tracked by `TODO.md` `AX-115`.

## DEC-025 — Path policy ownership on shell execution: the guard authorizes, the sandbox enforces, the tool plane extracts

**Status:** accepted. Resolves `ARCH/22` Open question 3 and `ARCH/12` Open question 5.

**Decision.** `CMP-guard` is the **sole path *authorization* owner** and `CMP-sandbox` is
the **sole path *enforcement* owner**. `CMP-tools` is a **resource extractor /
conservative pre-filter** only: it may attach resources and refuse an unparseable escape,
but it must never return a path `allow`/`ask`/`deny` and must never be the sole path
control. `exec.run` rules match the **command token prefix only** (`MatchMode::Raw`) and
MUST NOT carry path-shaped resources; a path named by a shell argument is expressed as an
`fs.*` resource (`MatchMode::Path`, the same grammar as the sandbox deny globs). A
path-shaped `exec.run` resource is a **configuration error, rejected at load**.

**Rationale.** `ARCH/12` already defines `exec.run` resources as "a command token prefix",
while `ARCH/10` and `horizoncode-tools::resources_from_input` push the raw `command` string
into the guard request. Nothing today implements a second path policy; this decision
prevents one from appearing. Forbidding path-shaped `exec.run` resources gives exactly one
path grammar and exactly one command matcher, and satisfies `REQ-SEC-023` ("no permission
evaluation outside the guard") with no capability loss — a path protection is still fully
expressible as an `fs.*` rule.

**Consequences.** `CMP-tools` gains an extraction step, not a decision step. The
`CMP-guard` CI gate extends to "no path-policy evaluation outside the guard". A CI
architecture check rejects a path-shaped `exec.run` rule at load and asserts that no
component other than the guard produces a path decision. The `ARCH/12` wildcard/glob open
question is answered by the one-path-matcher statement: one grammar, versioned, with a
shared parity corpus.

**Governs:** `REQ-SEC-003`, `REQ-SEC-023`, `REQ-SEC-025`; evidence in `ACC-P1-02` and the
`G-09` architecture gate. Detail in `ARCH/12` §Data / state model and §Configuration.
Tracked by `TODO.md` `AX-115`, `AX-121`.

## DEC-026 — Per-tier network guarantee levels; no universal "no network" claim

**Status note (2026-09-27).** The per-tier disclosure and fail-closed requirements
remain in force. `DEC-037` supersedes its mechanism-specific statements about Linux
syscall denial, macOS descendant behavior, and Windows implementation/availability.

**Status:** accepted. Resolves `ARCH/22` Open question 4, `ARCH/13` Open question 5, and
`ARCH/23` Open question 8.

**Decision.** Every supported tier MUST **declare** a network guarantee level —
`enforced` (demonstrated OS-level denial of prohibited network reachability), `capability`
(network denial by absence of an OS capability, not syscall filtering), `best_effort`
(a scoped mechanism with an explicitly recorded residual), or `none` (no network denial
is claimed) — together with its mechanism and
residual. The level MUST be surfaced wherever a
network-restricted profile is presented and recorded in that tier's acceptance record. A
caller that **requires** a level the tier does not provide MUST be **refused (fail
closed)**, never silently degraded, and a tier MUST NOT claim a level stronger than it can
prove.

**Rationale.** `REQ-GUARD-004` claimed "no outbound network" universally, but the
mechanisms differ and must be measured. Linux currently uses an unshared network
namespace, not a syscall filter. Windows confined execution is unavailable in this
source baseline. macOS emits a Seatbelt network rule, but descendant and IPC behavior
has not been accepted on a host. A caller requiring an unproven level gets a refusal,
never a silent downgrade (`DEC-037`).

**Consequences.** `ResolvedProfile` carries `network_guarantee_level` and
`network_residual` (surfaced as `ResolvedProfile.applied` notes). `ACC-P1-01(d)` probes
actual reachable paths and the recorded residual for the exact backend. Syscall policy,
capability state, and network reach are separate pieces of evidence. A tier claiming a
stronger level than it proves fails its acceptance row. `DEC-008`'s "network off"
wording states the *request*, and the tier record states the proven boundary.

**Governs:** `REQ-GUARD-004`, `REQ-VER-014`; evidence in `ACC-P1-01` and gate `G-4`;
residual risks `RR-07`, `RR-08`. Detail in `ARCH/13` §Platform notes. Tracked by
`TODO.md` `AX-113`, `AX-114`.

## DEC-027 — Formal read-through of `DEC-008`..`DEC-026`: "network off" is a request, never a uniform claim

**Status note (2026-09-27).** The distinction between requested posture and proven
enforcement remains in force. Its former Linux syscall-bar and cross-platform support
claims are superseded by `DEC-037`.

**Status:** accepted. The requested-versus-enforced distinction remains; mechanism
details were corrected in `DEC-037`, and the historical wording is not normative where
it conflicts with that correction.

**Question read through.** `DEC-008` records the default local profile as
"bubblewrap + Landlock + seccomp (**network off**, workspace-only writes)". `DEC-026`
introduced per-tier guarantee levels. Read together, does "network off" hold uniformly
across the requirement set, the delivery tasks, and the acceptance rows?

**Decision.**

1. **"Network off" states the *request*, not the *enforcement*.** Every default profile
   requests no outbound network on every tier; what each tier *enforces* is the
   `network_guarantee_level` it declares (`DEC-026`). The phrase is never a universal
   factual claim about the host.
2. **The required level is evidence-based.** Linux namespace reach isolation is not
   syscall denial. macOS and Windows guarantees are not assumed from their backend
   names; in the reviewed source Windows confinement is unavailable, while macOS host
   acceptance is absent. A tier that cannot prove the caller's required boundary refuses
   it rather than claiming an equivalent level (`DEC-037`).
3. **A required level the tier cannot provide is refused.** The difference between
   levels is enforced by a typed refusal, never by a silent downgrade (`DEC-026`).
4. **Mechanism and residual travel with the level.** A record for a tier that confines
   a process carries `network_guarantee_level`, `network_mechanism`, and
   `network_residual` (`ARCH/23` §Data / state model), and the level is surfaced
   wherever a network-restricted profile is presented.
5. **History is explicit.** `DEC-008` records the original target choice; current
   source and mechanism status are governed by `DEC-037`.

**Where each of the five residual items is now governed.**

| Item | Tier-honest statement now in force |
|---|---|
| `REQ-VER-005` (`ARCH/02`) | Probe network reachability and residual using the declared backend. A syscall-policy check is separate and is not a reachability substitute. Allowlist tests require a forced broker; the record stores `network_guarantee_level` / `network_mechanism` / `network_residual`; `ACC-P1-01(j)` is the refusal half. |
| `REQ-SEC-016` (`ARCH/02`) | Extension processes are confined with no ambient network **to the level the tier declares**, with the level, mechanism, and residual recorded and surfaced, and a stronger requirement refused. |
| `REQ-SEC-008` (`ARCH/02`) | Content still cannot create a rule, ticket, grant, or decision — and now explicitly cannot create, widen, or satisfy a **network** grant either; a network permission is a user act (`TB-0`) enforced at the declared level. |
| `AX-102` (`TODO.md`) | Linux uses bubblewrap namespace isolation in the current source; Landlock/seccomp are absent. Prove the actual network and filesystem reach boundary, including IPC and descendant paths; do not describe namespace isolation as syscall-level denial. |
| `AX-119` (`TODO.md`) | Extension-process confinement declares the tier's level with its residual, and a caller requiring a stronger level is refused. |

**Rationale.** The residual was a wording layer, not a design layer: after `DEC-026` the
design was already per-tier, but four of the five items below still read as a single
uniform "network off", so a reader could conclude that every supported tier proves what
only Linux proves. That is exactly the over-claim `ARCH/22` §Purpose exists to prevent
("a **residual risk** so nothing is over-claimed"; `RR-07`, `RR-08`). The fifth item,
`REQ-SEC-008`, was not over-claiming — it was *silent* on network, which is its own
hazard: a requirement that says content cannot create "a grant" without saying which
grants are in scope leaves the network grant ambiguous. It therefore now states the rule
instead of inheriting it. Rewording keeps the per-tier contract strict without
inventing platform guarantees. No security requirement was removed: the caller must
still refuse a tier that has not proven the required boundary. Linux namespace
isolation is described as reachability isolation, not syscall filtering; macOS and
Windows remain product targets but are not reported as accepted in the current source
snapshot.

**Consequences.** `ARCH/13` §Network guarantee levels, `ARCH/22` `TB-6`/`N-06`/`X-05`
and the `REQ-SEC-008`/`REQ-SEC-016` mapping rows, and `ARCH/23`'s `REQ-VER-005` row cite
this record. `ACC-P1-01` already asserted the declared level and already required the
three record fields, so no acceptance row changed meaning.

**Governs:** `REQ-VER-005`, `REQ-SEC-016`, `REQ-SEC-008`; `TODO.md` `AX-102`, `AX-119`.
Evidence in `ACC-P1-01(d)` and `ACC-P1-01(j)` and gate `G-4`; residual risks `RR-07`,
`RR-08`. Tracked by `TODO.md` `AX-102`, `AX-113`, `AX-114`, `AX-119`.

> `DEC-028` is currently unassigned; decision IDs are stable and are not reused. No
> active decision or requirement depends on a missing `DEC-028` record.

## DEC-029 — One durable run controller with independent verification

**Decision (2026-09-27).** `CMP-orch` becomes the deterministic controller for a long-horizon run. It owns the task DAG, state transitions, budget reservations, leases, retry history, stop decisions, and recovery. `CMP-session` owns the canonical append-only run/task events and rebuildable projections; `CMP-runner` continues to own a bounded model turn. A runtime verifier is a separately authorized service invoked by the controller. Its result may be `PASS`, `FAIL`, or `INSUFFICIENT_EVIDENCE`; the worker cannot mark its own task passed. `ARCH/25` defines the records and transitions. A multi-process daemon is an optional deployment mode when detached work requires it, not a second scheduler or separate product core.

**Why.** `ARCH/16` currently unlocks dependencies when they merely settle, and `ARCH/07` has no durable task, attempt, evidence, or effect schema. Both allow false completion after a restart. The existing turn loop cannot close that gap by longer prompts. The independent evaluation role is supported as an experiment by [long-running harness research](https://www.anthropic.com/engineering/harness-design-long-running-apps), but its value must be measured on our own tasks.

**Alternatives.** A Markdown TODO cannot provide atomic claims or leases. A separate orchestration framework would duplicate the existing control plane and increase consistency risk. A permanent team of specialist agents is not required; the roles may run sequentially and are routed by measured need.

**Consequences.** `REQ-HORIZON-005..010`, `REQ-REPO-001..002`, `REQ-DELIVERY-001`; tasks in `TODO.md`. Verified multi-hour completion is a differentiator, while fast interactive coding is an equally first-class product requirement. Ordinary prompt-led turns do not require creating a goal, preparing a plan, or accepting a Run review; the managed Run controller is used when the user requests it or the task warrants its durable planning, recovery, and independent verification. Latency, cost, permission friction, and breadth are measured alongside correctness rather than reasons to weaken verification.

## DEC-030 — Configurable operator surfaces and truthful source naming

**Decision (2026-09-27).** Keep a terminal-first native surface but allow IDE/ACP, headless, and future API clients to share the same state and settings. Theme, accessible colour palettes, layout, model/agent choice, compaction, budgets, routing, and usage/cost visibility are ordinary typed settings. A thin client may detach from an owned run without stopping it. Factual provider/model and source names are allowed in configuration, provenance, and usage screens. Product claims remain neutral and evidence-bound. An embedded editor is optional to complete coding work; governed external-editor handoff and semantic edits are supported paths.

**Why.** Verified long work requires an inspectable run and usable recovery controls. The prior absolute brand ban conflicts with named provider/model selection and license notices. An embedded editor cannot be the only edit path for files beyond its safety bound. This revises the terminal-first and single-binary constraints only where a detached controller or thin client proves necessary; deployment packaging remains one core executable where feasible.

**Consequences.** `REQ-UI-010..011`, `REQ-PROV-006`, `ARCH/06`, `ARCH/18`, `ARCH/25`. The older `G-9` brand scan becomes a claim/attribution validation gate rather than a ban on factual names. No peer-source code is copied without an allowed license and provenance record.

## DEC-031 — Correct contracts that overstate implemented mechanisms

**Decision (2026-09-27).** The network-level enum is `enforced | capability | best_effort | none`; each value has a mechanism-specific proof and residual, so `capability` is neither omitted nor silently equated to syscall denial. A model-supplied shell script executed as `sh -c` is an explicit shell effect, shown and authorized as such. Agent-owned HTTP follows one mediated egress; child network is separately denied or forced through an unbypassable broker. Multi-file patches preflight before mutation and use an effect journal for crash reconciliation. Audit uses a stable effect ID with prepare and terminal receipts: class coverage is only a static check, never proof that every runtime effect was recorded. A release claim must match what tests on that tier actually prove.

**Why.** `ARCH/02` omits `capability` from one enum while `ARCH/13` and `ARCH/23` use it; `ARCH/10` and the built `bash` tool execute `sh -c` despite an argv-only requirement; `ARCH/14`'s class census can pass with missing individual effects; current patch code loops through file operations after authorization and may stop mid-patch. These are contract bugs, not stylistic preferences.

**Consequences.** `REQ-GUARD-004`, `REQ-SEC-006..007`, `REQ-SEC-022`, `ARCH/10`, `ARCH/13`, `ARCH/14`, `ARCH/22`, `ARCH/23`, and the acceptance matrix require aligned implementation and evidence.

## DEC-032 — Progressive tool contracts and measured edit feedback

**Decision (2026-09-27).** Keep a searchable extension-tool catalog and select
only permitted, relevant schemas within the model step's token budget. Pin that
selection and policy snapshot until the step settles. Local/model-specific routes
may use a versioned text-edit parser when structured tool calls are unreliable,
but parser conformance, all-file preflight, bounded repair, and independent
revision-bound verification remain required. A detached run belongs to a
supervised controller process; clients attach by authenticated snapshot and
ordered event cursor rather than owning worker lifetime.

**Why.** [Claude Code public documentation](https://code.claude.com/docs/en/how-claude-code-works)
describes progressive context and deferred tool loading; [Aider's repository
map](https://aider.chat/docs/repomap.html), [edit formats](https://aider.chat/docs/more/edit-formats.html)
and [lint/test feedback](https://aider.chat/docs/usage/lint-test.html) demonstrate
small, targeted context and quick repair feedback. [Cline's documented hub/spoke
design](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/docs/sdk/architecture/hub-spoke.mdx)
separates client lifetime from worker lifetime. These are useful patterns, not
proof that their performance or implementation is best for HorizonCode.

**Alternatives.** Sending every MCP schema on every request wastes context on
large catalogs. Relying only on one edit format excludes models that can reason
but fail its parser. Letting a TUI own the run makes closing the terminal stop
multi-hour work. All three alternatives remain possible in a constrained mode,
but must not be advertised as the detached long-horizon capability.

**Consequences.** `REQ-CTX-010`, `REQ-PROV-007`, `REQ-HORIZON-011`,
`ARCH/09`, `ARCH/21`, `ARCH/25`, and `TODO.md` `AX-331..333`.

## DEC-033 — HorizonCode product and runtime identity

**Decision (2026-09-27; naming clarified 2026-09-28).** The product and GitHub
repository name is HorizonCode at `sarv-projects/horizoncode`. `hzcode` is the
canonical install, package, and executable name. After installation,
`horizoncode` is a compatibility command alias to the same version, process,
configuration, and state root; it must not create a second identity or copy of
state. New installation instructions and help use `hzcode`. The internal crate
prefix remains `horizoncode-`, and environment/config/state names use
`HORIZONCODE_*` and `~/.horizoncode`. Existing state is not moved implicitly;
`HORIZONCODE_HOME` can point at a previously created directory when the operator
intentionally resumes it. Historical Git commits, archived documents, and the
current checkout path retain their original identity. Stable task IDs such as
`AX-309` are not renumbered. The checked-out binary and manifests are still
named `horizoncode`; migration is delivery work under `AX-365..366`.

**Why.** The user named the final repository and requested a coherent rename.
Changing package and runtime identifiers together avoids shipping a new product
name with old binary, environment and persistence paths.

**Consequences.** Build metadata, source imports, CLI help, root documentation,
research notes and active architecture text use HorizonCode. The compatibility
choice for any publicly released predecessor remains an explicit migration
decision before release; no automatic state import is claimed.

## DEC-034 — Preserve money as typed, source-currency evidence

**Decision (2026-09-27).** A monetary observation is an amount plus ISO-4217 currency,
basis (`actual | estimated | included | unknown`), source, pricing version, and
observation time. Aggregation never adds unlike currencies. A converted display is an
optional view with an explicit exchange-rate source, timestamp, and rounding rule; it
never rewrites the original amount or historical budget evidence. Token/quota usage
remains separate from billed amount, including included or zero-billed plans.

**Why.** One `cost_usd` field cannot faithfully represent provider invoices or hosted
quotas denominated in other currencies, and a locale-based conversion can silently
change history. [DeepSeek-Reasonix's billing model](https://github.com/esengine/DeepSeek-Reasonix/blob/main-v2/docs/BILLING.md)
is a useful reference for separating source currency from valuations, not a schema to
copy. The current `horizoncode-analytics` schema is USD-only and does not satisfy this
decision.

**Consequences.** `REQ-ANALYTICS-007`, provider pricing, run budgets, analytics exports,
settings and UI require a migration and tests (`ARCH/11`, `ARCH/18`, `ARCH/20`,
`ARCH/25`; `TODO.md` `AX-334`). Unknown conversion means no combined total, not an
estimated zero.

## DEC-035 — Bounded request lanes and explicit event gaps

**Decision (2026-09-27).** Control-plane request classes use bounded, independently
timed lanes; a request that reaches its deadline releases its slot and leaves a typed
terminal result. Cancellation and permission responses cannot queue behind bulk
catalog/history reads. Event consumers use a bounded queue plus durable cursor replay;
overflow is an explicit gap requiring resnapshot/replay or a recoverable disconnect,
never silent drop or unbounded buffering. Fairness budgets ensure background work does
not starve interactive control.

**Why.** Current peer issues report stuck ACP permission prompts for child sessions and
app-server request lanes wedged by a hung call. Codex also documents an unbounded local
notification consumer as a way to avoid blocking its response channel; that trade-off
must not be adopted without a memory/backpressure bound. These reports are incident
evidence for failure scenarios, not proof that all releases share the defect. See
[OpenCode #48232](https://github.com/anomalyco/opencode/issues/48232),
[Codex #47842](https://github.com/openai/codex/issues/47842), and the
[Codex app-server client queue notes at the inspected snapshot](https://github.com/openai/codex/blob/41ed72c32b4980cd7919e1c2a45ecb1f96c5911a/codex-rs/app-server-client/README.md).

**Consequences.** `REQ-HORIZON-012..014`, adapter event schema, detached client attach,
ACP permission relay and settings/UI status; `ARCH/15`, `ARCH/16`, `ARCH/22`,
`ARCH/23`, `ARCH/25`; `TODO.md` `AX-335`.

## DEC-036 — Treat delegation as a measured optimization

**Decision (2026-09-27).** The controller may delegate only when task independence,
write-scope isolation, expected evidence gain, and remaining budget justify it. A
planner or subagent is not mandatory for every request. Compare delegated and
non-delegated runs under the same model, repository, task, resource limit, and
verification; account for prompt replay, wall time, failure variance, and integration
cost. Keep sequential execution as the default where decomposition adds overhead.

**Why.** DeepSeek-Reasonix's own small measured experiments show delegation cost varies
by task shape and can consume more tokens and wall time even when success is unchanged
([SPEC.md](https://github.com/esengine/DeepSeek-Reasonix/blob/main-v2/docs/SPEC.md)).
The numbers are project-reported and not generalizable; they are evidence against
assuming delegation always helps.

**Consequences.** `REQ-ORCH-006`, `ARCH/16`, `ARCH/25`, `research docs/tests.md`, and
`TODO.md` `AX-336`. Preserve user control, parent permission ceilings, and independent
verification for every worker.

## DEC-037 — State sandbox guarantees from reachable-path evidence and source status

**Decision (2026-09-27).** A network guarantee describes which network destinations a
confined process can reach under a named backend and configuration. It does not mean
the `connect()` syscall is denied, and it does not establish that `AF_UNIX`, inherited
descriptors, host services, VM sockets, helper processes, or descendants are confined.
Those paths are distinct test obligations. An `allowlist` is available only when a
forced broker is the sole possible egress path; mount/network namespace configuration
alone cannot prove per-host allowlisting. The ACP-independent controller must refuse a
requested guarantee the selected backend has not proven.

At source baseline `53a2654` (unchanged from `1c7a1c68bab9`), Linux uses bubblewrap namespaces and mount views; its source
explicitly says Landlock and seccomp are not installed. macOS source invokes Seatbelt,
but its process-tree/network residual has no host acceptance evidence. Windows confined
execution is unavailable in source. These are the current source facts; acceptance
status is separately bound to the build/platform record. No implementation is called
supported merely because a module or interface exists.

**Why.** The previous `DEC-026`/`DEC-027` wording incorrectly described Linux network
namespace reach isolation as a syscall-level bar, treated `AF_UNIX` outcomes as the
network proof, and carried forward unsupported macOS descendant and Windows support
claims. The sandbox implementation itself distinguishes namespace isolation from the
not-yet-installed filter layers. Reachability tests are the correct observable contract;
syscall policy is supporting evidence and must be reported separately.

**Consequences.** `DEC-026`/`DEC-027` remain in force for per-tier declaration,
disclosure, and refusal, with their mechanism claims superseded here. Amend
`REQ-GUARD-004`, `REQ-SEC-003`, `REQ-SEC-025`, `REQ-VER-005`, `ARCH/13`, `ARCH/22`, and
`ARCH/23`; the implementation and platform acceptance gaps remain in `TODO.md`
AX-101..AX-105 and AX-113..AX-114. No hard allowlist is accepted without an enforced
broker. Each record names the exact revision, backend, host, requested policy, observed
reachability, residual, and any syscall/capability evidence.

## DEC-038 — Separate agent discovery, installation, trust, enablement, and execution

**Decision (2026-09-27).** Treat an agent profile as a versioned, provenance-bearing
configuration record, not as proof that an executable or ACP peer is safe. Keep
discovery, add/install, pin, probe, trust review, enablement, and launch as distinct
operations. ACP is negotiated communication/session control; ACP Registry or another
catalog is discovery/distribution metadata. A catalog result never installs, trusts,
enables, launches, or widens permissions. Explicit local executable paths and remote
catalog entries use the same digest/version/platform/license checks. Native workers
and external agents share one panel and task-attempt view while retaining different
control and observability guarantees.

**Why.** ACP does not define general agent discovery or installation. Treating a
registry ID as a trusted runtime or assuming a peer's model/quota/cancellation controls
exist creates confused-deputy and false-observability risks. A single profile registry
also avoids separate, inconsistent controls for native and external subagents.

**Consequences.** `REQ-ORCH-007..009`, `ARCH/16`, `ARCH/25`,
`ARCH/27-COMMANDS-AGENTS-SETTINGS.md`, `TODO.md` `AX-340..342`. Keep provider model
metadata separate from agent profile identity; persist per-attempt capability and
usage provenance; unknown peer internals remain unknown.

## DEC-039 — The deterministic controller owns continuation and stopping

**Decision (2026-09-27).** A model can propose work or a stop, but only the durable
controller may dispatch, continue, pause, stop, or complete a run. Persist progress and
failure signatures, attempt/budget counters, pause fences, external wait conditions,
and tool-response batch outcomes across compaction, model/provider changes, peer
replacement, and restart. Buffer and validate the whole bounded model response before
dispatching any of its tool calls. A hard finite no-progress ceiling cannot be
overridden by a model evaluator. Timer/user/approval/event waits do not consume
inference while idle. Explicit user pause is distinct from condition wait, hard stop,
cancellation, and successful completion.

**Why.** Codex documents long-running work as a repeated plan/edit/execute/verify/
repair loop supported by a durable objective, plan, runbook, and status artifacts; its
~25-hour report is an experiment, not a universal reliability proof
([Codex long-horizon report](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex),
[ExecPlans](https://github.com/openai/openai-cookbook/blob/main/articles/codex_exec_plans.md)).
Public Codex issue reports describe runaway no-progress continuation and token-burning
future-time waits; MiMo-Code issue reports describe rotating tool-call floods defeating
adjacent-identical-call detection. These are version/user reports, not universal proof,
but they are concrete adversarial fixtures: [Codex #40929](https://github.com/openai/codex/issues/40929),
[#28923](https://github.com/openai/codex/issues/28923), [MiMo-Code #2482](https://github.com/XiaomiMiMo/MiMo-Code/issues/2482).

**Consequences.** `REQ-LOOP-008`, `REQ-HORIZON-015..017`, `REQ-UI-016`,
`ARCH/08`, `ARCH/16`, `ARCH/25`, `ARCH/27`, `ARCH/23`, and `TODO.md`
`AX-337..339`. Treat model evaluators as advisory. Measure false stop and false continue
rates, no-progress detection, lost work, repeated external effects, spend, and manual
recovery.

## DEC-040 — Commands and operator settings are typed projections over shared services

**Decision (2026-09-27).** Built-in and extension `/commands`, `@references`, settings,
keyboard actions, menus, and ACP/CLI control surfaces resolve through typed registries
and shared domain services. Unknown/malformed/unavailable commands fail visibly and
never fall through to model text. `@` references are typed context selectors and
cannot launch agents or grant effects by mention alone. Theme, semantic colors,
contrast/accessibility, notification channels, sound/bell, quiet hours, and warning
thresholds are user preferences with clear effective scope; muting a notification
cannot erase its durable event or mask a required approval/stop in the UI. User UI
preferences do not change authorization policy.

**Why.** Repeated ad hoc parsers create hidden command behavior and inconsistent
permission paths. A shared catalog makes help/completion, capability checks, settings,
and tests agree while preserving distinct terminal, headless, and protocol interaction
semantics.

**Consequences.** `REQ-UI-010..016`, `ARCH/06`, `ARCH/18`,
`ARCH/27-COMMANDS-AGENTS-SETTINGS.md`, and `TODO.md` `AX-340..344`. Every setting has
requested/effective values, source/lock, validation, apply boundary, schema version,
and test coverage. Theme meaning is never color-only.

## DEC-041 — Keep a self-contained living plan without making Markdown authoritative

**Decision (2026-09-27).** Each substantial run exposes a versioned self-contained
execution plan with goal/non-goals, repository orientation, task-linked milestones,
exact verification commands and expected outputs, progress, discoveries, decisions,
blockers, and outcome/retrospective notes. Store the canonical facts in the durable
run event/task/spec/evidence system and render the plan from that state. A plan
revision records its source event sequence and spec digest; it can explain and guide
work but cannot approve requirements, grant permissions, alter budgets, or assert task
completion. On resume, compare plan and workspace with the authoritative run log and
reconcile before acting.

**Why.** OpenAI's public long-horizon experiment and ExecPlans recipe demonstrate the
usefulness of externalized goals, constraints, exact paths/commands, observable
milestones, progress, surprises, decision logs, and handoffs. They are useful
operational patterns but are not a transactional store or proof of completion. Keep
the plan readable to a new worker while making stale-plan recovery deterministic.

**Consequences.** `ARCH/25` `ExecutionPlan`, `ARCH/24`, `research docs/codex.md`,
`research docs/long-horizon-architecture.md`, `research docs/tests.md`, and
`TODO.md` `AX-339`.

## DEC-042 — User stop intent enters the controller before agent continuation

**Decision (2026-09-27).** Structured pause/cancel/stop controls and unambiguous
natural-language directives are control-plane inputs, not ordinary prompts for the
worker. The ingress adapter records the input, fences continuation, and resolves its
target/action before any new model dispatch. If it cannot distinguish pause, cancel,
or the intended run, it keeps the fence and asks the user; it does not invoke the
worker to interpret whether the worker should stop. Negative or quoted references to
stopping remain ordinary content when the parser can establish that no control was
requested; uncertain cases prefer a temporary pause pending clarification.

**Why.** Codex's public Goal documentation describes structured pause/resume, queued
input checks, idle-boundary continuation, and no-tool-call suppression. Current public
issue reports nevertheless describe stop acknowledgements followed by empty,
repeated, or polling continuations, and goal context lost during compaction
([#37304](https://github.com/openai/codex/issues/37304),
[#32922](https://github.com/openai/codex/issues/32922),
[#45974](https://github.com/openai/codex/issues/45974)). Reports are version-specific,
but they show why prompt instructions alone cannot be the stop authority.

**Consequences.** `REQ-HORIZON-018`, `ARCH/08`, `ARCH/25`, `ARCH/27`,
`ARCH/23`, `research docs/codex.md`, `research docs/tests.md`, and `TODO.md`
`AX-337`, `AX-345`. Tests cover exact commands, clear natural-language directives,
negation/quotes, ambiguous scope, queued user input, compaction, pause/resume, empty
model outputs, and concurrent control requests.

## DEC-043 — Separate foreground task completion from maintenance drain

**Decision (2026-09-27).** A run becomes `COMPLETED` only after its required terminal
event and required evidence are durable. Once that boundary is crossed, optional
checkpoint compaction, search-index rebuilds, analytics rollups, and non-critical
cleanup may continue as separately supervised maintenance. Foreground commands must
either exit promptly with a durable completion receipt and `maintenance_pending`
details, or report a visible bounded wait while durability-critical work is pending;
they must never silently wait after printing success. Maintenance failure cannot
rewrite the task's verified result, but it remains visible and repairable.

**Why.** MiMo-Code #2504 reports a headless command printing its final response and
then waiting silently for a background checkpoint writer. This is a reported
version-specific issue, not evidence that every checkpoint implementation behaves
this way. The useful distinction is foreground contract versus maintenance lifecycle.

**Consequences.** `REQ-HORIZON-019`, `ARCH/25`, `ARCH/27`, `ARCH/23`,
`research docs/mimo-code.md`, `research docs/tests.md`, and `TODO.md` `AX-345`.
Critical event/audit persistence remains a completion prerequisite.

## DEC-044 — Audit sequence is global and verification is read-only

**Decision (2026-09-27).** Every audit entry has one globally monotonic
`audit_seq`; each segment also records `segment_id` and `segment_seq`. Cross-store
references use `audit_seq` and `effect_id`, while a physical entry location uses
`(segment_id, segment_seq)`. The current serialized `seq` already increases across
segments under one process; schema migration preserves it as `audit_seq` and derives
`segment_id` from the containing file and `segment_seq` from entry order. It MUST NOT
invent a global order for legacy entries whose order is genuinely unrecoverable.

`verify`, `replay`, and `census` are read-only over the evidence they inspect.
Read-access events go to an independent access-evidence stream so recording a read
does not open or mutate the store being inspected. Torn-tail repair is a separate,
explicitly authorized operation that preserves original bytes and emits a linked
recovery artifact; it never rewrites the original chain. Append-capable startup
refuses torn or malformed state until recovery is explicitly resolved. Writers acquire
an OS-backed cross-process lock before reading/reconciling the head or allocating a
sequence; a process-local mutex is insufficient.

**Why.** The LLD described sequence scope inconsistently and described verification
as truncating a torn tail. Source inspection found a more direct operational defect:
the audit CLI records access through writable `AuditLog::open` before calling the
read-only verifier, and ordinary open silently repairs torn tails. It also ignores
invalid head parsing and directory-enumeration errors, while its mutex is process-local.
These paths can mutate or misreport evidence during forensic inspection.

**Consequences.** Add `REQ-AUDIT-009..011`, update `ARCH/14`, `ARCH/23`,
`research docs/tests.md`, and `TODO.md` `AX-346`. Migration preserves the legacy
global `seq` as `audit_seq`, derives segment coordinates from file/order, and records
any genuinely unrecoverable sequence ambiguity rather than fabricating order.

## DEC-045 — State filesystem guarantees per enforcement mechanism

**Decision (2026-09-27).** HorizonCode MUST distinguish in-process file operations
from spawned-process containment. In-process operations use handle-relative and
no-follow APIs plus revalidation where supported; spawned children use the selected
OS backend. Architecture and product claims name the mechanism, platform, tested
boundary, and residual limits. A lexical/path pre-check is defense in depth, not proof
of kernel enforcement. If a caller requires a guarantee the selected path cannot
provide, the operation is refused.

**Why.** The source and tier contracts do not establish one universal kernel boundary
for every file API and platform. The previous requirement overclaimed mount/bind
containment and made the caller check and child sandbox appear to be equivalent. A
stronger guarantee can be required, but it must be tied to an implementation and
acceptance evidence rather than a generic component name.

**Consequences.** Update `REQ-SEC-005`, `ARCH/13`, `ARCH/22`, `ARCH/23`, and `TODO.md`
with mechanism-specific acceptance and platform scope. Keep Windows confined execution
unavailable until its backend is linked and accepted; no other tier inherits its
claims by interface similarity.

## DEC-046 — Deploy on the user-selected host

**Decision (2026-09-27).** HorizonCode's runtime, durable state, and workspaces are
owned by the machine selected by the user: a laptop/workstation for interactive work
or a user-managed server for headless and supervised long-running work. The product
does not require a HorizonCode-operated cloud control plane. Provider/model calls are
separate explicit egress routes; the UI and audit records identify the selected route
and governed data-transfer scope. Same-host detach/attach may use an OS-user-restricted
local control socket. Remote UI attachment, remote administration, hosted tenancy, and
multi-user server isolation are separate capabilities and MUST NOT be inferred from
headless server deployment.

**Why.** The user chose deployment location as an operator choice and clarified that
their SSH preference was for Git only; remote-agent access is outside the current
contract. A laptop and a self-managed server share the same runtime/control plane but
have different lifecycle, resource, and access surfaces. Treating “server” as an
implicit remote UI feature would invent an authorization and network boundary.

**Consequences.** `REQ-VISION-004`, `REQ-HORIZON-011`, `ARCH/01`, `ARCH/03`,
`ARCH/25`, `ARCH/27`, `research docs/mimo-code.md`, `research docs/tests.md`, and
`TODO.md` `AX-321`/`AX-331`. Remote attachment needs a later explicit requirement,
threat model, protocol, authentication design, and acceptance suite.

## DEC-047 — Separate goal selection from durable goal lifecycle

**Decision (2026-09-27).** The currently selected goal is a session/UI pointer over a
durable `RunGoal`, not a lifecycle state of that goal. `/goal clear` may remove that
pointer only after the run is terminal or explicitly paused/blocked; it does not
delete or rewrite the goal, run, task, attempt, budget, or evidence records. A paused
run remains resumable by ID after the pointer is cleared or rebuilt after restart.

**Why.** Combining “cleared from the current view” with the durable lifecycle made a
paused run potentially non-resumable even though `/goal clear` promised otherwise.
Selection is a UI projection; pause and completion are execution facts and have
different recovery semantics.

**Consequences.** `ARCH/25` adds `ActiveGoalPointer`; `ARCH/27` defines the clear
command boundary; `ARCH/23` and `research docs/tests.md` require pointer-clear,
restart, and resume-by-ID coverage. `TODO.md` `AX-337` tracks implementation.

## DEC-048 — Require digest-bound activation before long-running work

**Decision (2026-09-27).** A draft `RunGoal` is inert. Before any model, tool, or
external-agent dispatch, the user must explicitly start the run against the exact
displayed specification, task graph, and plan digests. The controller revalidates
blocking ambiguity, workspace/base revision, dependency graph, policy/capability, and
run plus verification/recovery budgets. Activation is idempotent by input delivery ID;
the durable activation receipt and reservation must reconcile before work is dispatched.

**Why.** `/goal set` created a draft and correctly prohibited dispatch, but the command
contract did not say how a user approved it. Treating a later message, stale preview,
or budget reservation as implicit approval could start work against a different spec
or start it twice after a retry/restart.

**Consequences.** `REQ-HORIZON-020`, `ARCH/25` `GoalStartIntent`/`GoalActivated`,
`ARCH/27` `/goal start`, and `ARCH/23`/`research docs/tests.md` stale-digest and
replay cases define the path. `TODO.md` `AX-337` tracks implementation.

## DEC-049 — Separate inert goal creation, bounded preparation, and execution approval

**Decision (2026-09-27).** `/goal set` stores only the original request and creates an
inert draft. A separate explicit `/goal prepare` may spend a finite planning budget on
read-only, revision-pinned repository discovery and planner inference. It cannot write
the workspace, launch coding workers, or perform external effects. The resulting
proposal is reviewed before `/goal start`; activation then requires a one-shot receipt
bound to the exact spec, task graph, plan, base revision, model/agent route, permission
scope, and budgets. Clarifications create new proposal digests. ACP uses negotiated
form elicitation or the exact one-use input receipt, and never treats ordinary “yes”
or a tool permission reply as task approval.

**Why.** The previous command contract asked `/goal set` to produce model-derived
success conditions despite promising no model inference, and `/goal start` required
digests that had no explicit preparation operation to create. Keeping drafting,
planning, and coding authorization as separate actions makes both intent validation
and planning cost visible without handing the planner coding authority.

**Consequences.** `REQ-HORIZON-020`, the `GoalPreparation` schema/transaction in
`ARCH/25`, `/goal prepare` and `/goal clarify` in `ARCH/27`, the review card in
`ARCH/06`, ACP interaction in `ARCH/15`, `ACC-H1-01`, and the preparation/approval
tests specify this workflow. ACP `elicitation/create` is an agent-to-client request;
only a configured trusted interactive connector with authenticated operator scope can
answer as the approver. `TODO.md` `AX-337` tracks implementation.

## DEC-050 — Keep operator control authority outside all worker process views

**Decision (2026-09-27).** The run/session/audit stores, credentials, operator-control
IPC, and trusted controller home remain outside all model-controlled tool, extension,
MCP, and peer process views. A typed principal is assigned by authenticated ingress;
only a trusted operator UI/CLI session or an authenticated, configured ACP connector
paired with the root HorizonCode agent session can mint approval receipts or change
control state. An outbound ACP peer/client process is never an operator. CLI
arguments, environment, protocol text, model output, and peer receipts cannot grant
the principal. Per-attempt scratch is separate from
canonical session/run state. A broad-access worker profile is available only when a
distinct worker identity or isolated VM/view proves this boundary; otherwise it is
refused. This applies even when a user opts into broad workspace or network access.

**Why.** A worker could otherwise invoke the CLI, reach a local socket, or edit local
state and forge the very approval, budget, or evidence used to verify its work.
Treating all same-UID processes as one trusted principal is incompatible with a
model-controlled subprocess unless the sandbox keeps the controller boundary out of
that subprocess. A bare unrestricted fallback therefore cannot support trustworthy
multi-hour completion claims.

**Consequences.** `REQ-SEC-026`, `ARCH/13` profile/ResolvedProfile rules,
`ARCH/22` `FO-16`/`O-08`/`O-09`, the operator principal, sealed `MutationContext`, and
approval receipt in `ARCH/25`,
surface rules in `ARCH/06`/`ARCH/15`/`ARCH/27`, and process-level acceptance tests
are mandatory. No controller API may accept caller-supplied actor/principal or a
caller-forgeable authorization object. Linux/macOS/Windows backend claims remain
unaccepted until the actual worker/control boundary is tested. `TODO.md` `AX-337` and
`AX-316` track the work.

## DEC-051 — Persist a one-use approval challenge and recoverable activation commit

**Decision (2026-09-27).** Opening `/goal start` creates an expiring durable
`GoalApprovalChallenge` bound to the canonical review-bundle digest, the exact
specification/task graph/plan/base/route/permission/budget digests, one authenticated
operator control session and connection, and an idempotent review delivery. At most
one challenge may be pending for a goal. A same-payload retry returns that challenge;
a changed payload under the same delivery ID conflicts. A newer review invalidates an
older still-pending challenge and is refused while an accepted start intent is being
reconciled. Consequential state changes, additional input, disconnection before
confirmation, session change while pending, or expiry invalidate a pending challenge.
Only an explicit response on the original trusted context can create a durable
one-shot approval receipt; after that, the same unexpired intent may recover across a
client disconnect, but not across a material policy/spec/budget change.

Activation uses a recoverable commit protocol, not a fictional transaction across
the event log, SQLite projection, budget ledger, and process launch. Persist accepted
confirmation and `GoalStartIntent`, reserve budgets with stable idempotency keys,
recheck policy/freshness, then append `GoalActivated` only after all required
reservations are durably confirmed. `GoalActivated` is the commit point. Dispatch
comes from a durable outbox keyed by that event and reuses stable attempt IDs. Before
the commit event, recovery may reconcile or release reservations but cannot dispatch;
after it, projection rebuild and outbox delivery are idempotent. Unknown launch state
blocks another attempt until process/workspace reconciliation.

**Why.** A digest-bound receipt without a persisted challenge does not establish
which exact review was presented, to which authenticated control session, or whether
it remains current after concurrent reviews, new input, expiry, or disconnection.
Separately, a claim of atomic approval+reservation+activation is not supported by the
documented multi-store architecture. A crash between reservation and dispatch could
otherwise strand budget or launch duplicate work.

**Consequences.** `REQ-HORIZON-021..024`, `ARCH/25` challenge/receipt/intent/outbox schemas,
partial unique/idempotency constraints and recovery protocol, `ARCH/06` confirmation
surface, `ARCH/27` `/goal start`/`/cancel`, `ACC-H1-07`, and `research docs/tests.md` race/crash
cases define the contract. `ARCH/24` `F-56` records the design defect. `TODO.md`
`AX-337` tracks implementation.

## DEC-052 — Make cancellation target-scoped and independently reconcilable

**Decision (2026-09-27).** `/cancel` carries an explicit `RUN`, `TASK`, or `ATTEMPT`
target. The controller resolves its ancestry and authorizes the matching operation
scope before writing a durable idempotent cancel request/fence. Run cancellation stops
all new claims; task cancellation stops only that task and leaves its descendants
blocked on the cancelled dependency; attempt cancellation stops only that attempt and
permits a retry only when normal policy, budget, and attempt limits allow it. All
scopes cooperate with in-flight work and reconcile effects before returning terminal
`CANCELLED`; unknown peer/process/effect state stays `RECONCILING`. Already-terminal
targets remain unchanged. `/stop-now` remains the explicit hard-stop path.

**Why.** The command/receipt advertised three cancellation scopes, but the typed
controller interface exposed only `cancel_run`, and natural-language `ControlIntent`
had no target kind or ID. Without a typed target, least-scope authorization, or an
idempotent persisted request, an adapter could cancel the wrong work, silently omit a
task/attempt cancellation, or claim success while an external effect was still live.

**Consequences.** `REQ-HORIZON-025`, the `CancelTarget`/`CancelRequest` schemas,
controller API, target state transitions and projection migration in `ARCH/25`, the
typed command grammar and status presentation in `ARCH/06`/`ARCH/27`, and
`ACC-H1-08` define the contract. `ARCH/24` `F-57` records the defect;
`TODO.md` `AX-337` and `AX-345` track implementation and control-intent routing.

## DEC-053 — Keep large session payloads outside the canonical event log

**Decision (2026-09-27).** Session events store bounded metadata and immutable
session-scoped artifact references; they never inline unbounded text or binary data.
Write and verify an artifact before appending the event that references it. The
append-only log remains canonical; indexes, blob manifests and UI previews are
rebuildable projections. Replay, provider rendering, export and verification must
validate the digest, length, format version and applicable resource limits, and must
surface unavailable/corrupt/unsupported content as typed state. Migrations are
copy-on-write generations with parent-log digests; garbage collection requires a
complete mark over retained owners plus expired leases, not refcounts alone.

**Why.** The [DeepSeek-Reasonix Studio release notes](https://github.com/esengine/DeepSeek-Reasonix/releases)
checked 2026-09-27 describe an upstream data-integrity failure in which base64 image
data made event logs exceed 128 MiB and prevented session save/recovery (details and
source scope in [`research docs/deepseek-reasonix.md`](../research%20docs/deepseek-reasonix.md)).
This is a peer-reported issue, not a reproduced HorizonCode failure. HorizonCode's
event log is also its replay/recovery authority;
unbounded payloads can cause log-read failure, memory exhaustion and loss of unrelated
committed work.

**Consequences.** `REQ-SESS-005`, `ARCH/07`'s `BlobRef`, commit protocol, migration and
projection schema, `ARCH/06` typed unavailable UI state, `ARCH/18`/`ARCH/27` bounded
storage settings, `ACC-P1-09`, and `research docs/tests.md` define the contract. Numeric
default ceilings are selected by `DEC-058`; workload and platform-specific durability
still need implementation evidence and acceptance before shipping. No unbounded
default is allowed.
`ARCH/24` `F-58` records the design gap; `TODO.md` `AX-348` tracks delivery.

## DEC-054 — Recover only proven remaining-context output truncation once

**Decision (2026-09-27, clarified 2026-09-30).** Keep a provider's pre-content
context-window rejection (`REQ-CTX-004`) distinct from a response cut off during
generation (`REQ-CTX-011`). A provider adapter may classify a truncation as
`remaining_context_cap` only when protocol evidence or an explicitly validated route
capability proves that the server used remaining context as its effective output cap.
The controller may compact and retry the same logical step exactly once only when
`compaction.auto=true`, the attempt produced no completed tool call or possible
provider-side effect, the pinned route and user/control/task/workspace/spec/policy
revisions are unchanged, and the budget reserves compaction, retry, and required
verification. Provider rejection recovery has the same `auto` and effect/revision
fences but is a separate recovery class. When automatic compaction is disabled, both
classes return typed recoverable errors without automatic compaction or retry.
Preserve partial bytes, finish reason, usage and attempt event for the UI/audit
record; never treat partial output as a completed assistant message. Explicit
configured output caps and unknown/ambiguous finish reasons do not trigger compaction
retry. A second rejection/truncation is terminal for automatic recovery.

**Why.** [Cline v4.1.21 (2026-09-24)](https://github.com/cline/cline/releases/tag/v4.1.21)
reports compact-and-retry for long local-model replies when servers cap output at
remaining context, while its release notes preserve the partial answer if recovery
cannot help and do not replay tool-activity turns. This is useful peer evidence, not
proof of a universal provider behavior. Retrying an indistinguishable `length`
finish can repeat a deliberately bounded response, duplicate visible text, or replay
an already-executed external tool. The adapter therefore needs trustworthy cause
evidence and the controller owns the retry fence.

**Consequences.** `REQ-CTX-011`, `ARCH/08`'s response-attempt state, `ARCH/11`'s
normalized finish reason and route capability, `ARCH/06`'s partial/truncated UI state,
`ACC-P1-10`, and the provider edge-case suite in `research docs/tests.md` define the
contract. `ARCH/24` `F-59` records the design gap; `TODO.md` `AX-349` tracks delivery.

## DEC-055 — Rotate canonical event logs without pruning their truth

**Decision (2026-09-27).** Session and run event histories use bounded-size immutable
segments plus one bounded active segment. Every event is sequence- and digest-linked;
each sealed segment records its sequence range, count, byte length, first/last digest,
and predecessor digest. A durable committed-head record identifies the last acknowledged
sequence and digest. The SQLite/index/manifest is rebuildable; it cannot override a
missing or mismatching committed head. Replay validates and streams segments in bounded
batches instead of reading the full log into one string/vector. A crash tail beyond the
head is preserved as uncommitted and reconciled by stable event/operation IDs before
recovery; committed bytes missing before the head are corruption and block completion.
No active run may prune canonical history. Event-log bytes are part of the same
hierarchical storage budget as artifacts, but use a distinct quota/reservation so a
large payload cannot consume the bytes needed for control and settlement records.
Before model/tool/effect dispatch, reserve bounded event capacity for that step and
retain a protected control/recovery reserve that the selected filesystem backend has
physically allocated before run activation; a ledger-only reservation is not a disk
reservation. The controller keeps the reserve file/journal inaccessible to workers
and consumes it only for required control, reconciliation, or handoff records. When
capacity is exhausted, fence new dispatch, reconcile in-flight work, and persist a
truthful `WAITING`/`STOPPED` outcome. If physical reservation is unsupported, do not
advertise the crash-durable multi-hour profile.
Only a separately authorized post-terminal retention/export operation may archive or
remove eligible history after digest verification and owner/evidence checks.

**Rationale.** The current `horizoncode-session` implementation writes each session to
one `<session-id>.jsonl` file and `read_events` materializes the entire file before
parsing it. That file and read allocation have no total-size/record-count bound. A
bounded artifact store fixes payload size but does not fix unbounded event count,
whole-log replay memory, or disk exhaustion. Segmentation bounds per-file work and
allows streaming replay; finite per-session/run quotas plus admission and emergency
reserves are still required because rotation alone does not make storage infinite.

**Consequences.** `REQ-SESS-006`, `REQ-HORIZON-027`, `ARCH/07`, `ARCH/25`, `ARCH/28`,
`ACC-P1-11`, `ACC-H1-10`, and the log-growth/recovery cases in `research docs/tests.md`
define the contract. `ARCH/24` `F-61` records the source/design defect; `TODO.md`
`AX-350` tracks implementation and migration. This is a proposed design, not a claim
that current code is segmented or bounded.

## DEC-056 — Read paths never repair canonical session history

**Decision (2026-09-27).** Listing, status, and read-only replay never mutate canonical
session/run bytes, the committed head, or recovery state. Only the explicit recovery
controller may reconcile an interrupted tail. It first preserves and hashes the
original bytes, identifies the last committed head, correlates stable event/effect
IDs, and records the recovery decision. It never truncates an uncommitted tail in
place. If resumption is safe, recovery starts a new immutable generation/segment and
appends deterministic synthetic turn closers only after the old tail is quarantined
and side effects are reconciled. If evidence is insufficient, it leaves the source
untouched and surfaces `RECONCILING`/`INSUFFICIENT_EVIDENCE` for operator review.

**Rationale.** In the inspected source, `SessionStore::read_events` calls
`fs::read_to_string`, then truncates a torn final line via `set_len`; `read_only`
delegates to this path, and `list` calls `load`, which can also append repair events.
Thus inspection can change the source of truth and silently remove bytes without
reconciling whether the partial record followed an external effect. Read intent and
recovery authority need distinct APIs and tests.

**Consequences.** `REQ-SESS-006`, `ARCH/06`, `ARCH/07`, `ARCH/25`, `ACC-P1-06`,
`ACC-P1-12`, and the non-mutation/recovery cases in `research docs/tests.md` define
the contract. `ARCH/24` `F-62` records read-path mutation and `F-64` records listing
errors hidden as absence; `TODO.md` `AX-351` and `AX-353` track the recovery and
enumeration migrations. No current source implementation is changed by this design
decision.

## DEC-057 — A durable commit includes namespace durability

**Decision (2026-09-27).** A `run_durable` commit is acknowledged only after the event
bytes and committed-head bytes are synchronized and any newly created/renamed segment,
seal, or head directory entry is synchronized using a platform backend that has a
declared and accepted contract. Rust `File::sync_data` alone is not treated as proof
that all metadata is durable; the platform backend must establish what it actually
flushes and how parent-directory updates are made durable. If a platform cannot
provide an acceptable mechanism, it cannot advertise the crash-durable profile.
Configured interactive weaker modes remain visibly weaker and can never be used for
a multi-hour run.

**Rationale.** The current session store creates `<session-id>.jsonl` and calls
`sync_data` on the file, but does not sync the containing directory. Rust documents
that `sync_data` might not synchronize metadata, and Linux documents that syncing a
file does not necessarily persist its directory entry. Windows and other platforms
have different APIs and failure semantics, so one generic API call is not evidence
of a universal durability guarantee. See [Rust `File::sync_data`](https://doc.rust-lang.org/std/fs/struct.File.html#method.sync_data),
[Linux `fsync(2)`](https://man7.org/linux/man-pages/man2/fsync.2.html), and
[SQLite's atomic-commit assumptions](https://sqlite.org/atomiccommit.html).

**Consequences.** `REQ-SESS-006`, `ARCH/07`, `ARCH/25`, `ACC-P1-11`,
`ACC-P1-13A` (the independently runnable commit primitive), `ACC-P1-13` (the
integrated segmented-store and reserve gate), and per-platform acceptance in
`research docs/tests.md` define the contract. `ACC-P1-13A` does not depend on
`ACC-P1-11` or `ACC-P1-13`; integration uses the primitive after its own gate is
available. `ARCH/24` `F-63` records the source durability gap; `TODO.md` `AX-352`
tracks the primitive and `AX-350` the integrated store. Source-level sync calls do
not prove host hardware honors flushes, so evidence states the tested tier and
residual assumptions.

## DEC-058 — Publish finite storage ceilings before the segmented logs exist

**Decision (2026-09-28).** The values below are the compiled **ceilings** and the
shipped defaults for event-log and artifact storage. A configuration, profile, or
surface may lower a value; none may raise it, because the compiled ceiling wins
(`ARCH/18`). Every value is finite and nonzero, so no code path can allocate or
accept an unbounded payload. They are chosen to bound worst-case work per record,
per file, and per session/run on a laptop-class filesystem while leaving enough
room for a multi-hour run; the segment numbers mirror the audit store's proven
4,096-entry / 8 MiB precedent (`DEFAULT_SEGMENT_MAX_ENTRIES`,
`DEFAULT_SEGMENT_MAX_BYTES`).

| Setting | Default = compiled ceiling | Why this number |
|---|---|---|
| `session.log.max_event_bytes` | 256 KiB (262,144) | A step, decision, or receipt larger than this is payload and belongs in the artifact store (`DEC-053`), not inline |
| `session.log.max_segment_bytes` | 8 MiB (8,388,608) | Mirrors the audit segment precedent; bounds one file's sync and one segment's replay allocation |
| `session.log.max_segment_events` | 4,096 | Mirrors the audit entry ceiling; keeps a dense control stream rotating regularly |
| `session.log.max_session_event_bytes` | 256 MiB (268,435,456) | Roughly a million control events at a realistic average — far above any interactive or multi-hour session, small enough to copy or export from a laptop |
| `session.log.control_reserve_bytes` | 4 MiB (4,194,304) | Physically allocated control/recovery capacity for terminal, reconciliation, and handoff records |
| `session.log.replay_batch_events` | 256 | Bounds projection work per batch; replay never loads a whole log |
| `run.log.max_event_bytes` | 256 KiB (262,144) | Same reasoning as the session record ceiling |
| `run.log.max_segment_bytes` | 8 MiB (8,388,608) | Same reasoning as the session segment ceiling |
| `run.log.max_segment_events` | 4,096 | Same reasoning as the session segment ceiling |
| `run.log.max_run_event_bytes` | 512 MiB (536,870,912) | A run aggregates many task/attempt/evidence streams, so it gets twice the session ceiling |
| `run.log.control_reserve_bytes` | 16 MiB (16,777,216) | A run's settlement set spans more stores and needs a larger protected reserve |
| `run.log.replay_batch_events` | 256 | Bounds projection work per batch |
| `session.artifacts.max_inline_event_bytes` | 64 KiB (65,536) | Keeps a maximal inline event comfortably inside one segment and one replay batch |
| `session.artifacts.max_object_bytes` | 64 MiB (67,108,864) | Holds test logs, images, and partial model attempts; small enough that one corrupt object cannot exhaust a disk |
| `session.artifacts.max_session_bytes` | 1 GiB (1,073,741,824) | All artifacts of one session namespace stay copyable for export |
| `run.artifacts.max_run_bytes` | 2 GiB (2,147,483,648) | A run aggregates evidence from many attempts; twice the session namespace |
| `session.artifacts.max_decoded_bytes` | 256 MiB (268,435,456) | Decoded pixels plus working buffers stay inside the class budget |
| `session.artifacts.max_decoded_pixels` | 16,777,216 (4096×4096) | Bounds render/decode work before any provider upload |
| `session.artifacts.max_expansion_ratio` | 128 | Refuses decompression bombs without rejecting ordinary formats |
| `session.artifacts.decode_timeout_ms` | 5,000 | Bounds wall clock for one decode; a timeout is typed, never a truncated result |
| `session.artifacts.retention_days` | 30 | GC eligibility for unreferenced objects; referenced, checkpointed, or exported evidence stays pinned regardless |
| `session.artifacts.orphan_grace_hours` | 24 | A crash window between byte publication and owner-event commit is recovered, not collected |

**Durability by platform.** The reference backend is the `run_durable` profile from
`DEC-057`: file `sync_all` followed by parent-directory `sync_all` on Linux and
macOS. Linux is the implementation and test target; macOS uses the same API path but
carries a declared, not yet accepted, contract. Windows cannot open a directory
through the standard API to synchronize it, so `run_durable` is **refused typed**
there and a multi-hour run is refused with it: a weaker profile is never silently
substituted (`DEC-057`, `ARCH/18`). Per-platform acceptance records are still
required (`ACC-P1-13`); this decision publishes the numbers and the refusal rule,
not verified hardware durability.

**Rationale.** `ARCH/07` and `ARCH/28` both require finite defaults before the
segmented logs and blob store can be implemented, and the earlier tables said
"exact values required before implementation". Choosing them once, in the schema
owner, prevents each store from inventing its own numbers and prevents a project
file from raising a safety ceiling. The values are conservative starting ceilings:
if a ceiling is too low, the operator gets a visible refusal and may lower the
configured value no further; raising the compiled ceiling requires a reviewed schema
and release decision. The cost of a ceiling that is too high or absent is an
unbounded allocation that no later check can undo.

**Consequences.** The `horizoncode-config` schema group `session.log.*`,
`run.log.*`, `session.artifacts.*`, `run.artifacts.*` carries these values as
defaults and ceilings with lower-only validation; the typed limit structs are what
`AX-309` (shared segmented event log), `AX-348` (artifact store), and `AX-350`
(session migration) consume. `ACC-P1-09`, `ACC-P1-11`, and `ACC-P1-13` define the
acceptance boundaries. Revising a number requires a new decision and a schema
version note; a benchmark that suggests different values records the revision
rather than editing this table in place.

## DEC-059 — One content hash: `blake3` for event and artifact identity

**Decision (2026-09-28).** Event digests, segment digests, and artifact identity use
`blake3`, the hashing dependency named in `ARCH/03` §5. An earlier `ARCH/07` draft
wrote `SHA-256` for the event digest and `blobs/sha256/` for the artifact path; that
wording is superseded by this decision rather than implemented. The digest domain
separators and canonical encodings are versioned, so changing the algorithm or the
encoding is a schema-version migration, never a silent change.

**Rationale.** Two hash functions inside one trust boundary double the review and
verification surface and invite mismatched checks. `ARCH/03` §5 chose `blake3` for
the audit chain and content hashing; the audit chain, the policy fingerprint, and
session `inputs_digest` already use it. Event and artifact identity is internal and
format-local, so there is no external interoperability requirement that would
justify a second algorithm.

**Consequences.** `horizoncode-eventlog` hashes events with `blake3` under the
versioned domain separator `horizoncode/eventlog/event/v1`, and `ARCH/28`'s
`ArtifactRef` field is renamed `digest` (the artifact store is not implemented yet,
so no stored data migrates). Any future change of algorithm or canonical form is a
schema-version migration with the version checked before partial decode.

## DEC-060 — OpenCode provider data refresh with native, pinned Rust adapters

**Decision (2026-09-28).** Keep HorizonCode's curated offline primary and generic
opt-in enrichment from `DEC-021`. Add an OpenCode-backed provider/model registry and
OpenCode Go model directory as explicit, named sources that automatically refresh in
the background by default (one-hour interval, user-disableable). Do not bundle the
full upstream provider database or marks. The cache is bounded, schema-validated,
provenance-stamped, content-addressed, and atomically replaced. Model/provider names,
catalog availability, and published capability/price/limit values may refresh as
inert data; they cannot introduce executable code, endpoint origins or paths, protocol
adapters, auth methods, or credentials. Go `/models` IDs indicate discovery only. The
Go model-to-path/protocol map is locally versioned Rust data derived from the current
official endpoint table; unknown IDs remain visible but unavailable until a released
adapter includes a reviewed route and conformance record. General OpenCode catalog
data and the Go directory use separate fixed source origins and separate provenance.

HorizonCode implements the OpenCode Go connector in native Rust, using the user's own
Go API key from the secret broker, its own User-Agent, stable opaque
`x-opencode-session`, mediated egress, and locally implemented protocol adapters. No
OpenCode token/client ID/auth store is reused and no OpenCode identity is impersonated.
Active attempts pin an immutable provider/model/adapter/capability/metadata snapshot;
refresh affects only future selections. The matrix enumerates every ID in each pinned
dynamic provider-feed snapshot, every documented provider setup method and sign-in
path, and records `unknown` where no primary source was found. Catalog presence, auth,
protocol, capability, terms/client registration, and availability are independent
fields. A provider is not claimed usable until its own supported auth and route
conformance evidence pass. If an auth flow requires an unavailable or unauthorized
independent client registration, show it as unavailable rather than bypassing the
requirement.

The 2026-09-28 snapshot is deliberately not treated as a consistent universal route
catalog: the global feed contained 225 provider IDs/8,253 models; Go `/models` returned
43 IDs, its global-feed `opencode-go` record contained 33, and current docs mapped 30
Go IDs to paths. These values and digests are recorded in the research inventory and
must be refreshed at implementation/acceptance. The provider feed's `env`, `npm`, and
`api` fields are not auth, package-installation, or endpoint authority. The Go
directory's model IDs do not select endpoint paths.

**Rationale.** User-approved automatic freshness is valuable for catalog breadth, but
remote metadata is not a safe executable update channel and catalog presence is not
provider compatibility. Keeping executable behavior in versioned Rust releases makes
protocol changes reviewable and allows active runs to remain reproducible. OpenCode's
provider docs distinguish catalog data, provider integrations, custom provider
configuration, and sign-in; its Go docs require the caller's own identity/session
headers and do not guarantee client compatibility indefinitely. See the exact source
snapshot and volatile-document limits in `research docs/opencode.md` and
`ARCH/29-SOURCE-TRACEABILITY.md` (`SRC-019`, `SRC-021`).

**Consequences.** Add `REQ-PROV-008..011`, `REQ-SEC-017`, `REQ-SEC-027`, `ARCH/11`,
`ARCH/18`, the provider/update UI in `ARCH/06`, the pinned provider/auth inventory in
`research docs/opencode-provider-inventory.md`, live free-model acceptance to
`research docs/tests.md`, and TODO `AX-360..364`. Changing this to arbitrary
auto-loaded adapters, an OpenCode auth-store import, or a user-selected untrusted
origin requires a new security decision.

## DEC-061 — Signed, explicit, active-run-safe application updates

**Decision (2026-09-28).** `CMP-update` owns application update discovery and
installation. Use The Update Framework (TUF) metadata/target verification rooted in
a separately authenticated installer bootstrap, with an offline threshold-signing
process, key rotation/revocation, per-target platform/channel/version/schema
constraints, bounded staging, atomic activation, health check, and rollback. Use the
first-party release repository `sarv-projects/horizoncode`; managed mirrors may
serve identical signed metadata but cannot change trust roots. TLS, same-origin
checksums, and attestations supplement, not replace, client verification. A Rust TUF
library is not selected until license/MSRV/maintenance/target/conformance review
passes; the current release-key/bootstrap process is not implemented. Preserve
`DEC-002`'s one-shipped-binary product contract: activation may run the signed
HorizonCode executable in a restricted internal helper mode, including as a separate
process on platforms that cannot replace a running executable; do not distribute a
second updater runtime.

On interactive TUI startup, when enabled, perform a rate-limited, non-blocking,
cancellable check of the locally selected channel (`stable` by default; `preview` only after an explicit
user choice and while signed preview targets are published). Non-interactive CLI and
headless invocations do not perform unsolicited update checks. Show a user-editable
notification only when verified metadata reports an update. Never install automatically. The notice, `/upgrade`, and `hzcode upgrade`
are clients of the same update service. The explicit Install action consents to download, verify, and apply at the next safe
restart boundary; it never terminates active work. If a run is active, stage and defer
until all work is terminal and the application reaches a normal process exit. A separate
maintenance approval is required only if applying would require pausing or reconciling
still-active work. Never ask for a second surprise confirmation after download. Package-manager-owned
installs are updated by their manager rather than overwritten. There is no `curl | sh`
or equivalent script bootstrap; convenience wrappers remain deferred until their
independent trust path is proven. Release packaging, audit, offline signing, and
platform install scripts are specified in `ARCH/30`.

**Rationale.** Update delivery is executable-code supply chain, not model metadata.
TUF addresses repository metadata/target substitution, rollback, freeze, mix-and-match,
and key-compromise classes; it does not remove the need to authenticate the first
installer or protect signing keys. Explicit consent and a maintenance fence protect
long-running work and make update deferral truthful.

**Consequences.** Add `REQ-UPDATE-001..007`, `ARCH/30`, settings/commands in
`ARCH/18`/`ARCH/27`, UI in `ARCH/06`, threats in `ARCH/22`, update acceptance in
`research docs/tests.md`, and TODO `AX-365..366`. Release is blocked until the first
root bootstrap, selected TUF implementation, per-platform install method, and rollback
compatibility are tested. Do not treat a development build or an unsigned mock
repository as release acceptance.

## DEC-062 — One durable sequencer for run admission and maintenance

**Decision (2026-09-28).** `CMP-orch` owns one bounded, append-only
`SupervisorControlStream` and cross-process admission lock for system-wide run,
worker-execution, direct-turn, and executable-maintenance admission. The stream records
run/work/maintenance intents, grants, and terminal settlement, with stable operation
IDs and references to the exact per-run stream head, session/execution, or update
operation. Per-run streams remain canonical for task,
attempt, and evidence truth; the supervisor stream owns only global admission and its
fence. SQLite remains a rebuildable projection. A pending or unknown intent blocks
conflicting admission until recovery reconciles per-run streams, execution/effect
state, the helper process, and installed binary digests.

**Rationale.** A per-run event log cannot serialize a new run or direct session turn
against a system update when no Run exists, and checking a rebuilt active-work count
before swapping leaves a start/update race. A global sequencer gives run/work admission
and maintenance one durable arbitration point without making the updater a second
scheduler or promoting SQLite into a source of truth.

**Consequences.** Add `REQ-HORIZON-029`, the `SupervisorControlStream` LLD to
`ARCH/25`, run/work admission APIs and the maintenance fence to `ARCH/16`, and
run/direct-turn/update race plus crash-recovery acceptance to `research docs/tests.md`.
Reuse the bounded event-log framing and OS-backed writer lock; fail closed if durable
locking or reconciliation is unsupported. `AX-365` depends on this controller seam.
No implementation is present.

## DEC-063 — One typed control API with an optional local app server

**Decision (2026-09-28).** All HorizonCode surfaces use one typed `CMP-control-api`
dispatcher that calls the existing domain owners. `CMP-app-client` and
`CMP-app-server` provide the same request/event semantics in process and across a
same-host IPC boundary. A supervised controller can run in the same shipped binary's
hidden `__supervisor` mode so the TUI may detach and reconnect without owning the Run.
The server owns process/socket lifecycle and transport only; `CMP-orch`, `CMP-session`,
`CMP-guard`, and other domain components remain the sole owners of their state and
decisions. ACP remains an external protocol adapter into the control service. The
initial app server is local-only; no remote listener is implied.

**Rationale.** `REQ-HORIZON-011` already requires supervised detached Runs, attach,
sequence replay, and truthful disconnect state, while `ARCH/27` exposes `/attach`.
Those contracts need a stable authenticated service boundary that is absent from the
current code and not specified as a single LLD. Codex's pinned
[`app-server-client` design](https://github.com/openai/codex/blob/368e5eae2f006a70a91dddfdc96e6b2d11498f81/codex-rs/app-server-client/README.md)
is evidence for sharing lifecycle and typed in-process transport; its unbounded local
event consumer queue conflicts with HorizonCode's bounded backpressure requirement
and is not adopted.

**Consequences.** Add `REQ-HORIZON-030`, `ARCH/31`, same-host IPC/authentication and
platform acceptance, with no separate state store or duplicate policy layer. Keep
remote attachment out until explicit authentication/encryption requirements and tests
exist. One binary can host both interactive client and hidden supervisor modes; if a
platform cannot provide the tested boundary, expose attached-only execution and refuse
to claim detached recovery. `AX-367` is proposed; no server/client implementation exists.

## DEC-064 — Run-scoped mailbox with explicit, non-authoritative delivery

**Status:** accepted architecture decision; implementation remains proposed.

**Decision.** Provide bounded operator/worker messaging for explicitly enabled
managed Runs. `CMP-orch` owns membership, ordered message events, idempotent delivery
state, and resource limits in the existing canonical Run stream. `CMP-session` owns
the recipient Session input receipt and safe-boundary promotion. A derived outbox
connects them using a stable per-message/per-recipient delivery ID and reconciles the
two stores after a crash. The `AgentMessagePosted` event contains bounded text inline;
no independent mailbox database or message event log is introduced. `CMP-guard`
remains the sole policy authority for the `agent.message` capability.

Messages are addressed only to explicit members of the same Run; task and session
identity do not collapse into one hierarchy. Message content is untrusted data and
cannot grant authority, alter an approved spec, transition a task, or count as
verification. Active agents receive a message only at a safe provider-turn boundary.
V1 does not wake or restart idle/paused/terminal workers. External messaging requires
an explicitly negotiated adapter bridge; ordinary ACP session/prompt support and
opaque CLI process handles are insufficient evidence.

**Alternatives considered.** Parent-only relays are simpler but bottleneck every
exchange through one live worker; ephemeral notifications lose delivery after a
restart; a separate service/store would add another consistency and permission
owner. The Run-stream/outbox design gives durable group coordination while preserving
one task-truth owner and bounded recovery. Costs include additional event bytes,
context exposure, notification/UI complexity, and a second-store reconciliation
path; all are explicitly capped and acceptance-tested.

**Consequences.** Add `REQ-HORIZON-031`, `ARCH/32`, message-panel/command/settings
contracts in `ARCH/06` and `ARCH/27`, `InputReceipt` provenance in `ARCH/25`, Codex
source comparison in `ARCH/26` and `research docs/codex.md`, and TODO `AX-368`.
Never equate a Codex message-board pattern with task truth or import its server
claims: the public client crate does not itself provide the remote service.

## DEC-065 — Local, rebuildable full-text search over committed session content

**Status:** accepted product/architecture direction; implementation remains proposed.

**Decision (2026-09-28).** `CMP-session` owns search over committed, authorized
session history. Use the existing local `state.db` for a versioned, rebuildable
SQLite FTS5 projection of displayable message text and session-title history. Keep
canonical segmented session events authoritative. Search returns stable message
targets and distinct title-only targets; it revalidates source event digests before
showing snippets or navigating. Use a bounded parser that emits only whole-token
queries and quoted contiguous token phrases. The initial tokenizer is
`unicode61 remove_diacritics 2`; punctuation is a separator, so phrase matching is
token-based rather than byte-for-byte substring matching. User and assistant display
text are indexed by default; tool output requires the user-scope opt-in. Hidden
reasoning, transient deltas, and non-displayable payloads are excluded. Results expose
incomplete/corrupt/unreadable index coverage. Search is local, cancellable, access
scoped, and independent of inference/network.

**Alternatives considered.** A linear scan avoids an index but has query cost that
grows with all retained history and cannot provide bounded interactive latency. A
separate search service/database adds another lifecycle, privacy boundary, and
cross-store reconciliation problem. The existing SQLite projection plus FTS5 keeps
the index rebuildable and local. OpenChamber's pinned search UI demonstrates useful
query-to-message navigation and title-aware session finding, but its message search
is limited to already-loaded user prompts and its session search is metadata-only;
HorizonCode's full-history index is a proposed synthesis, not copied behavior
([`research docs/openchamber-search.md`](../research%20docs/openchamber-search.md)).
The current local `libsqlite3-sys` build enables FTS5, but the implementation must
probe it at startup/migration and refuse typed if a future build lacks it; see
[`ARCH/07`](07-SESSION.md) and the exact local/upstream trail in `ARCH/29`.

**Consequences.** Add `REQ-SESS-007` and `REQ-UI-017`, message and title FTS schemas,
`session/title-changed` event projection, exact navigation/coverage behavior, search
settings, `/search` and `hzcode sessions search`, and adversarial rebuild/privacy
tests. TODO `AX-369` owns implementation. Do not claim search is present until
`ACC-P1-14` passes on an exact revision; FTS availability, complete enumeration,
rename aliases, query semantics, and result revalidation are release evidence.

## DEC-066 — Three-pane workspace with chat fixed at the center

**Status:** accepted target direction; no interactive TUI is implemented.

**Decision (2026-09-28).** The full-screen workspace defaults to exactly three
primary panes: Explorer/editor dock group on the left, chat in the center, and the
controller-backed Tasks checklist on the right. All three regions are resizable by
dragging their splitters; Explorer and Tasks can swap side slots, while the center slot
remains reserved for chat. Opening a file opens a tab in the left group and expands
that group; it never creates a second editor sidebar or replaces the central chat.
Side panes can be collapsed/restored. On narrow terminals, use a focused single-pane
layout with preserved state rather than illegible columns. Tasks are read-only
projections; a checkmark requires current independent PASS evidence for the integrated
revision.

**Rationale.** The user's main work surface is the conversation, while repository
navigation/editing and verified task progress remain visible in stable neighboring
panes. The prior `DEC-010` layout wording is superseded; its bounded editor scope and
governed write path remain in force. OpenCode's TUI is a behavioral comparison, not a
layout mandate; HorizonCode-specific three-pane behavior is captured in `ARCH/06`.

**Consequences.** `REQ-UI-018`, `ARCH/06`, and UI acceptance cases use this pane model.
The TUI must not add permanent bottom, right-editor, or duplicate task panes. Small
terminal behavior and pane keyboard/mouse movement are part of acceptance, not optional
polish. “Move” applies only to swapping Explorer and Tasks across side slots; the chat
anchor cannot be dragged away from center.

## DEC-067 — Scoped local memory with explicit writes by default

**Status:** accepted target defaults; storage implementation remains proposed.

**Decision (2026-09-28).** Memory is local-only and supports a user-global scope for
preferences/work habits and a project scope keyed by stable repository identity for
repository facts/decisions. Retrieval is scope-filtered before ranking. Cross-project
retrieval is off. A direct `/memory remember` user action can create a reviewable
candidate; automatic extraction is off by default and automatic acceptance is always
off. Users can inspect, export, disable retrieval, and purge by scope. A repository
fact is revision/provenance-bound and becomes stale when its source changes. No remote
embedding/index service is required.

**Rationale.** Global convenience should not create repository-data leakage or quietly
turn model inference into accepted user memory. Codex's two-phase extraction and
consolidation is a useful pattern to evaluate, while HorizonCode adds explicit scope and
consent rules; the exact upstream files are listed in `research docs/codex-memory.md`.

**Consequences.** `REQ-MEM-004`, `ARCH/33`, `/memory`, and `AX-371` use these defaults.
Bounds, retention, backup/export format, and deletion tombstone duration still require
implementation-time privacy review and finite settings; they do not change the defaults
above.

## DEC-068 — Workflow Builder authors controller plans, not a second runtime

**Status:** accepted target direction; implementation remains proposed.

**Decision (2026-09-28).** `/workflow create` opens a guided builder that produces a
versioned, validated task graph with typed inputs, dependencies, role/model hints,
permission ceiling, budgets, and verification criteria. Saving stores a local template.
Running it instantiates the ordinary HorizonCode Run controller and task lifecycle.
Templates cannot execute arbitrary scripts or bypass approval, guard, sandbox, audit,
budget, or verification. Begin with guided composition from user-authored steps and
small built-in templates; add graph editing only after interaction tests show it is
needed.

**Rationale.** Grok Build demonstrates useful workflow authoring, phases, validation,
limits, and journaling patterns, but its documented runtime does not recover across
process restarts and has unresolved external-effect replay behavior. HorizonCode already
needs a durable controller; a second scripting/runtime engine would duplicate state and
recovery semantics. See the pinned pattern-only source record `SRC-022`.

**Consequences.** `/workflow`, `ARCH/27`, `ARCH/25`, and `AX-377` share the controller
and validation path. Workflow templates are data, not executable authority.

## DEC-069 — Durable Thread identity and separate worker execution

**Status:** accepted target architecture; current store/API implementation remains
session-named and does not yet implement this model.

**Decision (2026-09-28).** HorizonCode uses one canonical durable `ThreadId` for an
agent conversation and its history (turns/items, context epochs, admitted input, and
replay). An `Attempt` may own a root Thread and a parent/child Thread tree. One Thread
may be served by successive `WorkerExecution` incarnations after a restart or adapter
recovery; each incarnation has its own ID, launch receipt, heartbeat, capability and
usage observations, and fenced workspace ownership. `Session` is reserved for a
protocol/provider/peer concept (ACP session, OpenCode Session, or an adapter's native
conversation handle), stored as an external binding to the HorizonCode Thread. The
current `horizoncode-session` crate may remain the persistence implementation name,
but its target public/domain contract is Thread-oriented and must not create both a
`SessionId` and `ThreadId` for the same HorizonCode conversation.

The durable task DAG describes required work; the Thread tree describes agent
conversations and delegation. They have independent IDs and relations. A Thread or
WorkerExecution ending never passes an Attempt or Task; only current verifier evidence
bound to the approved specification and integrated revision can do that. Opaque peers
may have a HorizonCode Thread with only partial history/capability visibility; missing
peer session, nested-agent, usage, or resume fields stay `UNKNOWN`.

**Rationale.** Codex's durable Thread and OpenCode's durable Session both demonstrate
the value of a persistent conversation identity, while OpenCode's source explicitly
separates its process-local active runner from durable history. A normalized Thread
gives HorizonCode one internal term across Codex, OpenCode, ACP, Claude Code, and native
workers without adopting any peer's Task semantics. The already-required
`WorkerExecution` captures the live incarnation; adding another core `Session` entity
would duplicate identity and confuse protocol sessions with durable work.

**Consequences.** `ARCH/07`, `ARCH/16`, `ARCH/25`, `ARCH/26`, `ARCH/32`, requirements,
source traces, and tests must use `ThreadId` for HorizonCode conversations and clearly
name external session bindings. `AX-379` owns the cross-document schema/API migration
and compatibility plan. Preserve legacy on-disk history through an explicit
versioned/idempotent migration; never rewrite or duplicate a conversation silently.

## DEC-070 — Freeze provider fallback policy per managed attempt

**Status:** proposed architecture decision; route retry/failover implementation and
acceptance remain open.

**Decision (2026-09-29).** At managed-attempt admission, persist the selected route
and an ordered, policy-approved fallback chain with provider/model/adapter capability
and pricing references. A metadata refresh cannot edit that chain. Each actual
provider/model dispatch receives its own immutable route snapshot and usage identity.
Cross-route fallback is permitted only for a typed transient failure before any
provider content or tool-call delta has been exposed to the runner, only when the
next entry was in the pinned chain, satisfies the task's required capabilities and
permission/egress policy, and has budget reserved. Authentication, authorization,
quota exhaustion, policy/egress denial, protocol/schema errors, capability mismatch,
user cancellation, and any failure after content/tool-call exposure do not trigger
cross-provider fallback. Such outcomes are surfaced for bounded retry, replan, or
user action according to their typed class. Same-route transport retries remain
bounded by `ARCH/11` and count against the same logical request budget.

**Rationale.** Pinning only the currently selected model is insufficient if a retry
can silently switch provider, endpoint, cost basis, or data recipient. A bounded,
pre-authorized chain preserves recoverability without changing an active task's
authority or concealing where data was sent.

**Consequences.** Add `REQ-PROV-012`; `ARCH/11` owns route resolution and retry
semantics, `ARCH/25` owns managed budget reservations/effects, and `ARCH/23` plus
`research docs/tests.md` own failover and crash acceptance. `/usage`, run review,
audit, and delivery evidence show every attempted provider/model, outcome, data
exposure boundary, and spend. No chain entry may be inferred from live metadata or
provider identity alone.

## DEC-071 — Provider quota observations are advisory and separately owned

**Status:** proposed target architecture; no provider quota reader or cache exists.

**Decision (2026-09-29).** Optional provider-account quota observations are fetched
only by documented, authorized read-only `CMP-provider` adapters. Background refresh
is disabled unless the user enables it at user/managed scope for that provider;
project configuration cannot enable it. Manual refresh is available where supported.
A bounded provider-owned cache stores immutable-while-retained observations and a
rebuildable latest view with provenance and freshness. `CMP-analytics` and the UI
project those source facts but never fetch or own them. Observed provider windows can
produce a clearly labeled warning only; they never influence routing or dispatch,
modify or replace HorizonCode's atomic local reservations, or become an enforceable
shared-account ceiling. Explicit cache clear/retention removes complete records and
their derived analytics rows without revoking provider credentials. The secret broker
remains the sole credential resolver/refresh owner.

**Rationale.** Quota endpoints, windows, reset semantics, and credential requirements
vary or may not exist. Optional read-only observation supports accurate operator
visibility without letting stale/provider-reported state weaken local spend controls
or silently introduce credential-store access.

**Consequences.** `REQ-PROV-014`, `ARCH/11`, `ARCH/20`, `ARCH/27`, `AX-386`, and the
quota-observer fixtures define implementation and verification. A provider with no
documented and authorized quota surface remains `unsupported`/`unknown`; no generic
header scraping or other application's local transcript/account scraping is added.

## DEC-072 — Build child context explicitly; isolate memory by profile

**Status:** proposed target architecture; no ContextPacket builder or child memory
namespace exists in the implementation.

**Decision (2026-09-29).** A worker starts with a fresh context assembled by
`CMP-context` from a bounded, revision-bound `ContextPacket`: approved task/spec
contract, explicit source references, effective instructions and skills, permission
ceiling, and task-relevant accepted memory permitted by the effective memory policy.
`fork=none` is the default. Parent transcript, sibling transcript, and parent auto-
memory are not copied wholesale. An explicitly authorized bounded fork carries only
named committed user-visible message references and a budget; full-history fork is
limited to a native first-party worker within the same trust/data boundary and remains
unavailable to external adapters. External peers receive no memory by default; a
user/managed setting and the adapter's negotiated data-egress capability must both
permit each memory loadout.

Optional `AgentProfile` memory is a namespace under the existing user/project memory
store, keyed by stable profile ID, never a second storage service. Shared memory and
profile-private memory are selected independently, filtered for accepted/current
status and child-task relevance, and pinned by record ID/revision/digest to the child
`ContextEpoch`. Children can submit candidates through the existing `CMP-memory`
review path, but cannot directly accept, re-scope, or delete records. Injected memory
remains untrusted context, not authority or evidence. The UI and usage ledger expose
the loadout sources, omissions/staleness, and input-token impact where observed.

**Rationale.** Official Claude Code documentation describes fresh subagent context,
explicit skill preloading, and separately configured per-subagent memory; parent auto-
memory does not automatically transfer. `claude-mem` public documentation describes
hook-based context injection, while a historical issue reports duplicated context in
agent teams but does not establish current behavior. The robust transferable pattern
is deliberate child-context construction, not automatic parent-context duplication.
The user-linked `codeaashu/claude-code` repository explicitly identifies its source as
leaked and unlicensed; only its README/Licence claims were read, and no source detail is
used. See `research docs/claude.md` and `research docs/claude-mem.md`.

**Consequences.** Add `REQ-MEM-005..007`; `ARCH/09`, `ARCH/16`, `ARCH/18`, `ARCH/27`,
and `ARCH/33` own packet assembly, policy/settings, profile namespaces, project
identity, idempotent injection, and retrieval. `CMP-session` is the shared workspace /
project identity seam; `CMP-orch` pins it to a Run and child worktrees inherit it.
`AX-371` remains the implementation owner, coordinated with Thread migration under
AX-379. Acceptance measures fan-out token multiplication and tests identity
consistency, policy, privacy, staleness, idempotent resume/compaction, nested-child,
and external-adapter boundaries before enabling memory by default.

## DEC-073 — Reduced-approval posture is a bounded, run-scoped grant, not a policy override

**Status:** accepted target contract; current source violates it (`ARCH/24` `F-84`, `TODO.md` `AX-370`). Recorded 2026-09-29 to close a citation gap: `REQ-GUARD-005` and `ARCH/12` required this posture, but no decision entry defined it and three citations attributed it to `DEC-040`, which governs typed operator settings rather than approval authority.

**Decision.** A user-selectable reduced-approval posture MAY auto-approve only eligible `ask` decisions inside the active run's already-approved authority ceiling. It MUST NOT override explicit `deny`, catastrophic-effect gates (including broad recursive deletion and destructive Git cleanup/reset/checkout/clean), sandbox/confinement limits, managed locks, required enforcement backends, production-data or publish actions, secret export, or configured external-network boundaries. It MUST NOT be activated or widened by project, agent, plugin, prompt, or model content. Storing the preference is not activation: activation requires a local, explicit, auditable acknowledgement bound to a run with a finite expiry. The agent may offer the user a clearly labeled choice to enable reduced approval for a managed `/goal`; only the user can accept that exact run-bound scope. The active reduced-approval posture, its remaining scope, and its composition with a `full-access` profile MUST remain visible in every effect-capable surface; deactivation fences new dispatch and revokes unused tickets while in-flight effects are reconciled and never retroactively undone. Permission eligibility and run-loop progress remain separate controls: no auto-approval setting disables the durable no-progress or repeated-batch ceilings. Ordinary direct turns use routine local permission defaults and do not require reduced-approval mode.

**Why.** An authority switch whose only home was a requirement paragraph invites drift in both directions — the legacy source path mapped every surviving `Ask` to `Allow`, broader than `REQ-GUARD-005` (`ARCH/24` `F-84`), while the mis-citation to `DEC-040` left the posture's real boundaries unrecorded. `ARCH/24` `F-43` shows the failure class: a remembered approval must never disable no-progress protection.

**Consequences.** `REQ-GUARD-005`, `ARCH/12` §Plan/act/reduced-approval, `ARCH/22` `G-05`/`RR-04`, `ARCH/27` §Reduced-approval, and the `ARCH/18` settings contract cite this record. `AX-370` implements the eligible-class filter, acknowledgement, expiry/revocation, and UI/status acceptance; this record changes no behavior beyond replacing the incorrect citations and stating the boundaries `REQ-GUARD-005` already required.

## DEC-074 — Native editor handoff is the primary editing surface

**Status:** proposed target architecture; current TUI/editor bridge is not implemented.

**Decision (2026-09-29).** Keep the Explorer, read-only code view, and live diff in
HorizonCode; use the user's configured editor for normal source editing. Resolve an
explicit HorizonCode editor profile first, then `$VISUAL`/`$EDITOR`, then a user
configured fallback. Profiles cover common GUI and terminal editors, including VS
Code, Cursor, Zed, JetBrains IDEs, Neovim, Helix, Vim, Emacs, nano, and micro; a
custom argv template supports other editors. Profiles explicitly choose
`terminal_wait`, `gui_wait`, or `gui_detach`, including editor-specific wait flags.
Do not infer lifecycle from executable-name substring tests or pass paths through a
shell. A waiting editor suspends HorizonCode's terminal input/rendering, then restores
terminal modes in error-safe cleanup, queries current dimensions, invalidates layout
caches, and rebuilds virtualized offsets. A detached editor creates a visible
operator-edit lock for the selected path until the user clears it; this is a
HorizonCode dispatch fence, not proof that the editor closed or an OS file lock.

Before opening a path an active turn may edit, stop or pause the turn and reconcile
unknown effects. Never release a write lease while the worker continues. Filesystem
watch events refresh saved bytes and the diff but cannot observe unsaved buffers; the
authoritative write path always rechecks the current raw content digest immediately
before mutation. A stale-base patch may be merged only against its exact captured
base and current bytes. Unique, non-overlapping hunks may be rebased deterministically
and compare-and-swapped against the current digest; ambiguity or overlap produces an
interactive conflict review. CRLF/LF normalization may assist alignment, but raw
bytes remain the authorization/CAS boundary and trailing whitespace is never
discarded globally.

The left dock's default is **Turn Diff**, comparing the working files with the
pre-turn snapshot. A separate **Total Worktree Diff** shows cumulative working-tree
changes against the selected Git baseline, including pre-existing user edits. Neither
view stages, commits, or rewrites Git state. Direct turns and editor handoff never
auto-stage or auto-commit. Rewind/checkpoint storage is HorizonCode-owned and MUST
not alter the user's `.git`, index, reflog, or commit history.

**Rationale.** Native editors provide the user's key bindings, language services, and
format-on-save behavior. The TUI remains useful for navigation, review, and safe
handoff without becoming a second general-purpose editor. The exact editor lifecycle
must be explicit because terminal programs and GUI daemons have different wait and
terminal ownership semantics.

**Consequences.** Replaces the v1 embedded-editor scope in `DEC-010` and updates
`REQ-UI-005`, `ARCH/06`, `ARCH/07`, `ARCH/08`, `ARCH/10`, `ARCH/12`, and `ARCH/18`.
Safe merge, concurrent-edit, terminal-resume, no-Git-mutation, and multi-editor
acceptance belongs to `research docs/tests.md` and the owning TODO tasks.

## DEC-075 — Everyday coding uses direct turns; managed Runs remain optional

**Status:** proposed target architecture; direct turn workflow and short-task
benchmark are not yet accepted.

**Decision (2026-09-29).** The ordinary coding workflow begins from a natural-language
prompt and can answer, inspect, edit, run a relevant check, show a diff, and accept a
correction without first creating a goal, planning artifact, or Run approval. Chat /
Explore, Plan, and Code are user-selectable interaction modes; they change what the
user asks HorizonCode to do, not the durable source of task/session truth. Plan output
is advisory until the user chooses execution. `/goal` invokes the existing managed Run
controller for tasks that benefit from explicit decomposition, budgets, detach/recover,
and independent verification.

V1 keeps `REQ-TOOL-003` intact: tools excluded by the effective hard/user policy remain
absent from the model request. A universal byte-identical tool schema across modes and
cache-neutral mode switching are deferred beyond V1. Provider request-shape/cache
behavior is route-specific; no cache hit, latency, or cost improvement is promised
without pinned route evidence. Direct turns have explicit cancellation and bounded
per-turn resources with visible continuation; numerical defaults are selected from
the paired short-task evaluation, not guessed in advance. Context compaction for a
direct Thread uses a lightweight rebuildable summary plus a recent verbatim tail and
preserves the active request, user corrections, decisions, evidence, and open
questions. The canonical Thread log remains the source of truth.

For V1, `Code` is the default interactive mode for a new composer unless the user has
saved another preference; `Chat/Explore`, `Plan`, and `Code` remain user-selected modes
enforced before effects. The tool set is materialized from both the active mode and the effective
permission policy; tools unavailable in that mode are not advertised, and policy-
denied tools remain absent under `REQ-TOOL-003`. The mode transition may change the
request schema and context epoch, so cache reuse is a measured route behavior rather
than a contract. No V1 `MODE_READ_ONLY` settlement is required because mode-excluded
tools are not offered; stale calls against a prior mode still fail typed at settlement.

Everyday permission defaults should avoid repeated approval for the same unchanged,
narrow action/resource while its exact grant is valid. The UI explains the action,
resource, grant scope/expiry, and reason for each prompt. Only the user can enable
reduced approval for a managed Run after an explicit review; an agent may offer the
choice but cannot activate it. Hard denies, catastrophic effects, confinement,
required enforcement, and external-effect gates remain in force.

**Consequences.** Updates `ARCH/01`, `ARCH/02`, `ARCH/06`, `ARCH/08`, `ARCH/09`,
`ARCH/12`, `ARCH/27`, `ARCH/20`, and `research docs/tests.md`. `REQ-TOOL-003` is not
weakened. `/specdriven` is optional and uses the same Run controller when execution
is selected; `/hooks` is an inspection/trust surface, not another policy engine.

## DEC-076 — Track upstream provider changes and maintain native integrations

**Status:** proposed target architecture; provider-source synchronization is not
implemented.

**Decision (2026-09-29).** HorizonCode targets provider-integration parity with the
documented provider connectors in pinned OpenCode and Cline source snapshots. Maintain
a versioned provider-source matrix that records each upstream provider, auth/setup
method, protocol family, model mapping, source revision, applicable per-file license
and notice, local adapter status, conformance status, and any blocker. When monitored
upstream sources change, an automated maintenance job detects the change and prepares
a reviewable HorizonCode update candidate: refresh the matrix, identify changed
provider/auth/protocol behavior, selectively port only license-cleared material or
reimplement the documented behavior, and run route-conformance fixtures. Candidate
changes enter HorizonCode's own source tree and signed release through the normal
review/update process. They do not download, compile, or execute upstream code at
runtime, and they never silently alter an active route or installed binary.

The product target is usable integration parity for every provider connector in the
monitored OpenCode/Cline snapshots. A row with an auth, terms, protocol, or conformance
blocker is visible, but means parity is still incomplete; it cannot be counted as
supported. Resolve the blocker through an authorized HorizonCode credential route or
keep the limitation explicit. Models.dev/catalog presence alone never means
integrated. Do not reuse another product's OAuth client ID, auth store, cookies, or
identity. Source updates remain subject to `ARCH/05` per-file provenance/license
review; source compatibility does not establish legal permission or route correctness.

**Rationale.** Broad provider choice is a core product requirement. A metadata-only
catalog becomes stale as an integration surface when upstream connectors evolve.
Monitoring and preparing native, reviewable updates makes support track upstream
changes while preserving route reproducibility, user identity, and signed-release
control.

**Consequences.** Amends `DEC-060` from catalog-only maintenance to catalog plus
upstream adapter maintenance, without changing its data-only runtime rule. Updates
`REQ-PROV-002`, `REQ-PROV-010`, `REQ-PROV-011`, `REQ-SEC-017`, `ARCH/05`, `ARCH/11`,
`ARCH/24`, `ARCH/29`, `ARCH/30`, the provider inventory, and TODO `AX-360..363`.
Every integration still requires a source pin, license/notice record, capability
evidence, supported auth, route-specific conformance, and honest availability state.

## DEC-077 — Hooks and shell execution remain subordinate to Guard

**Status:** proposed target architecture; user/project hook execution and selectable
shell profiles are not implemented.

**Decision (2026-09-29).** Provide one `/hooks` inspection and trust command over the
existing extension/tool ownership. Hook invocations use a bounded versioned JSON
request on stdin and typed JSON response on stdout; diagnostics use stderr. Hook
profiles declare event, executable/argv, timeout, input/output limits, environment,
and source digest. Project hooks require explicit trust for the exact reviewed digest;
any material change requires renewed review. Spawned hooks receive a minimal
allowlisted environment with inherited HorizonCode control/credential variables
removed and read-only event/workspace descriptors where supported. Hooks can observe
or make the effective decision stricter; they cannot grant permission, bypass Guard,
alter audit truth, or declare verification success. Failures follow the event's
declared fail-closed or optional-observer policy and are visible.

The user can configure the shell used for `exec.run` (including PowerShell, Bash,
POSIX shells, and Windows command shells) through typed executable/argv profiles.
Commands continue through the same Guard, sandbox, and audit path. Pipe mode is the
default for noninteractive commands; a PTY is available only for an explicitly
interactive command/profile. PTY allocation changes I/O behavior, not confinement.
Process cancellation supervises the command tree with a grace period and forced
termination where the OS supports it; unknown descendants/effects remain explicit
and fence conflicting follow-up work.

**Rationale.** Structured hooks and shell profiles improve extensibility and fit
different developer environments, while hook code and shell commands remain
untrusted effects. A TTY is an I/O facility, not a security boundary.

**Consequences.** Updates `ARCH/02`, `ARCH/10`, `ARCH/13`, `ARCH/21`, `ARCH/22`,
`ARCH/27`, and `research docs/tests.md`. A hook never becomes a second permission
engine, and a PTY never upgrades a sandbox tier.

## DEC-078 — Extension commands converge on one category-aware manager

**Status:** proposed target architecture; the interactive Extensions overlay is not
implemented.

**Decision (2026-09-29).** Provide one centered Extensions overlay for Connector/service
discovery, MCP servers, skills, plugins, hooks, workflows, and marketplace discovery.
`/extensions` opens its overview; `/connectors` (`/apps`), the singular/plural MCP,
skill, and plugin command aliases and the `/hooks`, `/workflows`, and `/marketplace`
commands open the same surface with the
matching category selected. `/create-skill` deep-links to Skills → Create in that
surface; it does not auto-activate the new skill. The shared manager retains Search,
Installed, and Create flows where applicable. `/workflow` remains the typed authoring and Run-controller
command family; it may deep-link into the Workflows category but does not add a second
workflow runtime. Opening the manager is read-only navigation and cannot install,
enable, trust, execute, or grant permission. Preserve composer/layout state and fetch
only the selected category or bounded summaries, with cancellable loading and explicit
empty/stale/error states. Noninteractive surfaces return typed results instead of
pretending to open a TUI.

**Rationale.** Users should find and manage related extensions through one predictable
surface while keeping discovery, trust, activation, and execution as separate states.
Grok Build's pinned Extensions modal and slash-command routes provide a source-backed
navigation pattern only; HorizonCode keeps its own install transaction, guard, trust,
and data ownership.

**Consequences.** Updates `REQ-UI-020`, `ARCH/06`, `ARCH/21`, `ARCH/27`, and task
`AX-378`. Source evidence is recorded as `SRC-029`/`U-GROK-EXTENSIONS` and
`SRC-031`/`U-GROK-SKILLS`; no upstream code is copied.

## DEC-079 — One read-only diagnostics service, named guarded repairs

**Status:** proposed target architecture; no HorizonCode Doctor implementation exists.

**Decision (2026-09-29).** Provide a single `CMP-diagnostics` report service surfaced
through `hzcode doctor [--json]` and interactive `/doctor`. The default report is local,
bounded, read-only, and offline. It combines applicable host, terminal, configuration,
provider-capability, extension, and declared-enforcement observations without turning
unknown/unavailable into healthy. Stable finding IDs, typed observation states, evidence
references, and remediation use one versioned report schema and finding rules; facts
that a surface cannot observe stay explicitly unavailable/not checked. Any startup
warning that points to Doctor uses the same stable finding ID and rule. Provider
connectivity remains a separate explicitly requested, cost-bearing `hzcode providers
test` operation. The service does not own policy, credentials, config, provider clients,
or sandbox truth.

Automated repair is limited to a finite registry of first-party fixes. Planning rechecks
the current finding and target; the user sees the exact target and change; authenticated
confirmation uses the normal Guard/control path; application goes through the owning
service with safe replacement/backup behavior and the durable prepare plus exactly-one
terminal receipt required by `REQ-AUDIT-001`; inability to record the prepare blocks the
effect. A postcondition check reports success or failure. No free-form shell repair,
fix-all, or unattended `--yes` path. A configured confinement profile is reported as configured unless the
declared tier has independent runtime evidence proving enforcement; diagnostics cannot
upgrade a sandbox claim.

**Rationale.** Grok Build's Doctor source provides a useful shared-facts/report pattern,
stable findings, human/JSON output, and named fix planning. HorizonCode needs host and
operator readiness diagnostics across CLI and TUI, but its repairs must use the existing
Guard, authenticated control session, audit, and owned config services. The focused
source references are Grok Build's pinned [`doctor_cmd/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/doctor_cmd/mod.rs),
[`diagnostics/model.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/diagnostics/model.rs),
and [`diagnostics/fix.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/diagnostics/fix.rs)
(`SRC-030`; full path map: [`ARCH/29` U-GROK-DOCTOR](29-SOURCE-TRACEABILITY.md#u-grok-doctor)).

**Consequences.** Adds `REQ-UI-029`, `CMP-diagnostics`, the `ARCH/27` diagnostics and
command contracts, `ACC-DIAG-01`, and proposed task `AX-392`. Pattern provenance is
`SRC-030` / `U-GROK-DOCTOR`; no code or tests are copied.

## DEC-080 — Preserve colliding skills through source-qualified invocation

**Status:** proposed target architecture; skill activation and slash invocation are
not implemented.

**Decision (2026-09-29, clarified 2026-09-30).** A skill whose unqualified name is
already owned by a built-in command remains discoverable and invocable through a
source-qualified key. The stable grammar is
`/<source-kind>:<source-id>:<skill-name>` (for example `/plugin:acme:login`); a
same-source duplicate name additionally includes its canonical relative skill path
as escaped path segments. `source-id` is a stable URL-safe identity supplied by the
source/registry, never a display label, load order, or transient filesystem listing
index. The built-in keeps its normal bare name. Every colliding skill is qualified;
the registry rejects any residual key collision and reports both sources rather
than choosing by discovery or registration order. The full qualified key and source
are shown in completion/help. `/skill` and `/skills` continue to open the Skills
manager and do not invoke an arbitrary skill. Skill invocation is an explicit
separate route and rechecks source identity, canonical path, and content digest
before loading the body.

This rule is specific to dynamically discovered skill invocation. User-authored
command descriptors retain the collision-rejection rule in `ARCH/27`; they do not
gain a shadowing or qualification escape hatch. Skill content remains untrusted and
cannot grant authority.

**Rationale.** Rejecting an ambiguous bare name should not make an otherwise valid
skill inaccessible. Source kind alone is insufficient when two plugins share a skill
name, so the canonical key includes both source kind and stable source identity, with
path disambiguation only for duplicates within that same source. This preserves
built-in behavior, keeps each skill addressable, and makes provenance visible at the
invocation point.
Grok Build's pinned skill guide documents built-in precedence and source-qualified
skill names; HorizonCode specifies its own deterministic collision handling and
digest check (`SRC-031` / `U-GROK-SKILLS`).

**Consequences.** Adds `REQ-SKILL-005`; updates `ARCH/21`, `ARCH/27`, `ACC-SKILL-01`,
and proposed tasks `AX-373`/`AX-378`. No code is copied.

## DEC-081 — One action path with task-first progressive disclosure

**Status:** proposed target architecture; interactive TUI and action catalog are not
implemented.

**Decision (2026-09-30).** Preserve HorizonCode's exactly three primary panes
(`DEC-066`). Buttons, command palette, slash commands, and shortcuts are affordances
for one stable action identity and controller path; they do not create separate
behavior or permission routes. Do not adopt iCode's `bypass` approval mode; HorizonCode
keeps Guard ceilings and exact, scoped approvals. Inline composer suggestions preserve
the draft and focus until explicit commit. File references inserted with `@file:` remain distinct
from opening a file in the Explorer/editor dock. The default Tasks list is task-first:
show the requested task and concise user-relevant state/action; retain Attempt,
Thread, WorkerExecution, adapter, event, and evidence detail behind task selection or
the operational inspector, and preserve all canonical identities in controller data.
Background completion updates state in place without unsolicited navigation. The
Extensions Installed view starts with item/type/lifecycle and primary action; advanced
provenance, scope, capability, probe, and configuration detail is revealed at the
selected-item or staged-review step.

**Rationale.** iCode's command/action, inline-suggestion, responsive-screen, and
drill-in patterns are useful interaction evidence, but its chat/sidebar layout and
agent-configuration forms do not replace HorizonCode's chosen workspace or its
simple Extensions entry surface. The pinned review also confirms iCode's Explore is
an agent profile, not a project-file Explorer; its `@` picker inserts references,
and Ctrl+O edits the prompt rather than opening project files. HorizonCode's own
Explorer/file opener remains defined by `ARCH/06`/`AX-208`.

**Consequences.** Adds `REQ-UI-030`; clarifies `ARCH/06` and `ARCH/27`; updates
`AX-009`, `AX-108`, `AX-207`, `AX-208`, `AX-335`, `AX-369`, `AX-374`, `AX-375`,
`AX-378`, and `AX-388` acceptance scope. The interaction evidence is `SRC-035`/`U-ICODE-TUI` and
`U-ICODE-COMPACTION` in `ARCH/05`, `ARCH/29`, and
`research docs/icode-ui-review.md`. It changes no pane geometry, controller authority,
permission posture, or runtime owner.

## DEC-082 — Federated extension catalog with product-local connections

**Status:** proposed target architecture; no Shared Extension Market service, catalog
ingestor, external connector runtime, or broad catalog snapshot exists.

**Decision (2026-09-30).** Treat the market as a federated metadata/distribution
catalog served by one product-neutral, read-only Shared Extension Market and consumed
first by HorizonCode and later by AgentCowork. Do not create a new
universal execution format or manually implement every integration. Normalize only
listing identity, source/provenance, package family, declared capabilities/host
requirements, versions, compatibility, and evidence; preserve the upstream document
and unsupported fields. Support read-only MCP Registry ingestion, documented portable
Agent Plugins and Claude/Grok Git marketplace adapters, Agent Skills packages from
curated/user-selected sources, and HorizonCode-curated Connector/service records.
Only public documented feeds, user-provided sources, or publisher-authorized sources
may be indexed; do not scrape closed directories or inherit another vendor's OAuth.

The market distinguishes Connector/service, provider offer, account Connection,
MCP server, skill package, plugin bundle, capability, and permission grant. One
Connector listing may expose several provider offers; a bundle is one listing and its
embedded components do not increase the unique-entry target unless published
independently. Marketplace search is metadata-only. It never executes code or
activates a skill. Existing local owners (`CMP-config`, `CMP-mcp`, `CMP-tools`,
`CMP-secrets`, `CMP-guard`, `CMP-sandbox`) retain install, activation, secret,
authorization, and execution authority. `CMP-extension-catalog` owns source
adaptation, indexing, deduplication, and listing/compatibility evidence only. The
separately deployed market uses one controlled ingestion/review pipeline and publishes
versioned JSON snapshots through a public read API/CDN; both products consume the same
catalog revision. Its first release has no executable package hosting, public
submission/write API, marketplace accounts, or ratings; packages remain at upstream
locations. Product clients cache/filter the snapshot and may add explicitly scoped
user sources.

The broad-release catalog goal is at least 500 unique, source-resolvable,
type-qualified entries, with 1,000 as the expansion target; dated per-source and
per-family snapshots must prove counts. Listed, resolved, compatible, probed,
reviewed, publisher-verified, official, and enabled are distinct claims with scoped,
dated evidence. Quantity cannot weaken trust gates. HorizonCode ranks developer
services first; the shared catalog may include AgentCowork's wider service categories.
Installation, enabled state, account Connections, credentials, and grants remain
local to each product. No provider-gateway dependency is selected by this decision;
any such adapter needs a separate review of cost, terms, security, and data handling.

**Rationale.** Codex documents portable plugin packages and separate local/repository
marketplace sources; Claude Code documents Git-backed marketplace manifests and
component bundles; Grok Build combines several plugin/skill/MCP management views and
documents Claude-format compatibility; the MCP Registry provides a machine-readable
read API with pagination and incremental updates. These are different source and
runtime contracts, not one interchangeable marketplace protocol. The product needs
catalog breadth and clear Connector discovery without confusing service accounts
with package installation or trusting catalog claims.

**Consequences.** Adds `REQ-PLUGIN-005/006`, `CMP-extension-catalog`, a Connectors
category in the shared Extensions UI, and proposed delivery tasks `AX-393`/`AX-394`;
expands `AX-378` to include its UI entry points. Acceptance is `ACC-MARKET-01` and
`ACC-CONNECTION-01`. Source
observations are in `SRC-036`, `ARCH/29` (`U-EXTENSION-ECOSYSTEM`), and
`research docs/extension-marketplace-review.md`. No upstream code or schema is copied.
