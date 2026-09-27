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

**Decision.** HorizonCode implements ACP as a first-class **server** (usable by clients) and a first-class **client** (driving peer agents as subordinates) with equal standing. This supersedes the "later" qualifier in `DEC-003`. Capability negotiation gates every optional call in both roles.

**Rationale.** Being both usable and composable is a stated product priority and the seam that lets HorizonCode orchestrate peers without a second engine (`REQ-PROTO-004`, `REQ-PROTO-006`).

## DEC-020 — Multiple append-only stores under one cross-store invariant

**Status:** accepted.

**Decision.** Keep **separate** append-only stores, each owned by exactly one component, rather than collapsing them into a single log: the session event log (`CMP-session`; replay source of truth), the tamper-evident audit chain (`CMP-audit`; independently verifiable evidence), and the analytics ledger (`CMP-analytics`; rebuildable rollup source). Each store owns its own ordering and retention. Where one effect appears in more than one store, the stores MUST satisfy a **cross-store consistency invariant**: a security-relevant effect is complete only once its audit entry is durably chained, and every session/analytics fact that references it carries the owning `session_id`, its monotonic session `seq`, and the audit `seq` (or `receipt_ref`). Ordering is defined by each store's own monotonic sequence; **cross-store ordering is never inferred from wall-clock time** — the audit `seq` is the authoritative tie-break for security-relevant ordering, and a reconciliation check flags any referenced effect that has no audit entry. Retention stays per-store: the audit chain is never pruned with the session log or the analytics ledger.

**Rationale.** A single store would couple replay, tamper-evidence, and derived metrics: an analytics retention choice could put the audit chain at risk, and a corrupt session log could poison evidence. Separate stores keep each guarantee provable while an explicit invariant stops them drifting into disagreement (`REQ-AUDIT-001`, `REQ-AUDIT-006`, `DEC-004`, `DEC-005`, `DEC-017`; detail in `ARCH/14`).

## DEC-021 — Model catalog posture: curated primary, opt-in enrichment, no bundled marks

**Status:** accepted. Closes the `SRC-009` data-license hard gate.

**Decision.**

1. **The built-in catalog is a small, internally curated subset** covering only the providers and models HorizonCode actually supports. Every row carries provenance: source URL, retrieval date, generating method or script, and a pinned upstream commit wherever a value is derived. Limits and pricing are verified against provider-published documentation and cross-checked against a second permissively licensed community map.
2. **Runtime enrichment is opt-in.** With network permission, the catalog MAY be refreshed from the upstream public API through an explicit `catalog refresh` command, with opt-in, timeout, schema validation, and offline-by-default behavior. The cache records source URL, retrieval timestamp, content hash, and upstream commit when known. Live data **MUST NOT** silently overwrite pinned eval fixtures.
3. **No full dataset snapshot in the binary by default.** The grant permits it with the notice retained, but it is rejected as the default posture: it imports daily staleness, community-data accuracy liability that upstream explicitly disclaims, and binary bloat — for no compliance benefit over (1) + (2).
4. **No third-party marks are bundled.** Provider and model names appear as plain text (nominative use). Provider logos are NOT redistributed: the upstream grant conveys no trademark rights. Names MUST stay factually accurate and MUST NOT imply endorsement.
5. **Attribution is unconditional.** Any bundled or derived catalog data ships the upstream copyright line and full permission notice through `THIRD-PARTY-NOTICES` and a `--credits` / `about` surface, satisfying the MIT notice condition for every row regardless of which tier supplied it.

**Rationale.** The grant is permissive and verified from primary sources, so redistribution is legally available. The real risk is operational, not legal: a pseudonymous holder, no contributor agreement, unaddressed database rights, and third-party marks inside the data. A small verified primary keeps offline determinism and eval reproducibility, bounds staleness liability, and keeps provenance defensible per row rather than per dataset. Runtime enrichment restores breadth without making correctness depend on it. Excluding marks removes the one clearly unlicensed element (`SRC-009`, `DEC-011`, `AX-010`, `REQ-PROV-*`; detail in `ARCH/05` §5 and `ARCH/11`).

**Residual risk (accepted).** Upstream title to every byte of a community-curated dataset is not fully provable from public sources; no contributor agreement exists upstream; EU sui generis database rights are not addressed by the grant; upstream disclaims accuracy entirely, so pricing and limit errors are our operational liability. Mitigation is the per-row provenance record plus cross-verification — not a stronger license claim.

## DEC-022 — Audit anchoring: signed roots always, a declared anchoring level, an honest claim boundary

**Status:** accepted. Resolves `ARCH/22` Open question 1 and `ARCH/14` Open question 1.

**Decision.**

1. **Signing is not configurable off.** Every audit segment root is signed with a
   device key held by `CMP-secrets`. `audit.anchor.sign: false` is a configuration
   error, not a supported posture.
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
| `local-trust` | `none` | signed roots only, in the audit store; no independent verification claim. Permitted only as an explicit, acknowledged posture and labeled everywhere. |
| `local-sink` (**default**) | `file` | signed roots appended to a distinct, ownership- and mode-validated append-only sink **outside** `<state-dir>/audit`. |
| `off-box` | `remote` | signed roots recorded off-host or counter-signed; the required level for any deployment that declares an off-box trust requirement. |

**Rationale.** `REQ-AUDIT-004` (strict: signed *and* anchored off-box) and `ARCH/14`'s
`offbox: "none"` default genuinely conflicted. The stricter requirement stays the floor,
and the weaker statement is scoped to the case where it is demonstrably true (a
genuinely local-only deployment). A fresh install cannot invent a remote sink, so the
honest zero-config default is the strongest level that needs no external party: signed
roots written to a sink *outside* the audit store root. That defends against
audit-store-local rewriting and against a *different* unprivileged principal (`AV-6`),
which are exactly the in-scope adversaries; `off-box` is reserved for the claim that
survives against the invoking user (out of scope per the threat model, but a deployment
may still require it). The requirement also had to stop over-claiming: a chain — even
anchored — proves detection of modification of already-anchored history, never content
authenticity, and never detects fabrication in the unanchored tail.

**Consequences.** `"offbox": "file"` replaces `"none"` as the shipped default
(`ARCH/14` §Configuration), with `sink_path` validated per `REQ-SEC-018` and a
`trust_requirement` key (`none` | `off_box`); `"none"` continues to work but must carry
an explicit `local-trust` acknowledgement. Signing once and only once is the contract, so
`sign: false` is rejected at load. A deployment that declares `trust_requirement:
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
**spawn-time confinement**: the resolved profile's scoped roots plus kernel-enforced deny
globs applied to the whole process tree. Specifically:

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
aspirational. This keeps the stricter rule (`REQ-SEC-005`: kernel-level containment) as
the floor and scopes the weak statement to the role where it is true: a conservative
pre-filter that may only *raise* a decision. "Asked" rather than "denied" preserves the
documented `external_directory` capability while the kernel still bounds reach
(`REQ-SEC-010`: authorization is not reach).

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

**Status:** accepted. Resolves `ARCH/22` Open question 4, `ARCH/13` Open question 5, and
`ARCH/23` Open question 8.

**Decision.** Every supported tier MUST **declare** a network guarantee level — `enforced`
(kernel/syscall or OS-capability denial of egress), `best_effort` (denial limited to the
wrapped process; an escaped descendant is not separately confined), or `none` — together
with its mechanism and its residual. The level MUST be surfaced wherever a
network-restricted profile is presented and recorded in that tier's acceptance record. A
caller that **requires** a level the tier does not provide MUST be **refused (fail
closed)**, never silently degraded, and a tier MUST NOT claim a level stronger than it can
prove.

**Rationale.** `REQ-GUARD-004` claimed "no outbound network" universally, but the
mechanisms differ: Linux is a real syscall/namespace denial (`enforced`); Windows is an
application-container **capability absence** (`capability` — deny-by-absence, not a
syscall filter, and job objects do not deny network); macOS is a Seatbelt rule for the
wrapped process with no separate confinement of an escaped descendant (`best_effort`).
Restating per level keeps the strict floor where it is real (Linux must prove the syscall
bar) and scopes the weaker statement to where it is true, with mandatory disclosure — the
treatment `RR-07`/`RR-08` already hint at. Preserving capability matters: macOS is **not**
forced to declare itself unsupported; it is honest about its level, and a caller requiring
`enforced` gets a refusal, never a silent downgrade.

**Consequences.** `ResolvedProfile` carries `network_guarantee_level` and
`network_residual` (surfaced as `ResolvedProfile.applied` notes). `ACC-P1-01(d)` asserts
the tier's **declared** level: the syscall assertion for `enforced`, the capability-
absence assertion plus a failing outbound attempt for `capability`, and the Seatbelt rule
assertion **plus** proof that the residual is disclosed for `best_effort`. A tier claiming
a stronger level than it proves fails its acceptance row. `DEC-008`'s "network off"
wording is read through this decision: the phrase states the *request*, and the tier's
declared level states what is enforced.

**Governs:** `REQ-GUARD-004`, `REQ-VER-014`; evidence in `ACC-P1-01` and gate `G-4`;
residual risks `RR-07`, `RR-08`. Detail in `ARCH/13` §Platform notes. Tracked by
`TODO.md` `AX-113`, `AX-114`.

## DEC-027 — Formal read-through of `DEC-008`..`DEC-026`: "network off" is a request, never a uniform claim

**Status:** accepted. A read-through, not a rewrite: no earlier record is edited, and
`DEC-008` remains in force and intact. Discharges the remaining `DEC-026` consequences.

**Question read through.** `DEC-008` records the default local profile as
"bubblewrap + Landlock + seccomp (**network off**, workspace-only writes)". `DEC-026`
introduced per-tier guarantee levels. Read together, does "network off" hold uniformly
across the requirement set, the delivery tasks, and the acceptance rows?

**Decision.**

1. **"Network off" states the *request*, not the *enforcement*.** Every default profile
   requests no outbound network on every tier; what each tier *enforces* is the
   `network_guarantee_level` it declares (`DEC-026`). The phrase is never a universal
   factual claim about the host.
2. **The strict floor is preserved, not averaged away.** Linux remains `enforced`: any
   profile advertised as network-restricted MUST be proven at the syscall/namespace
   bar, and a Linux tier that cannot reach that bar MUST refuse the profile rather than
   claim a weaker level as if it were the same thing. macOS (`best_effort`) and Windows
   (`capability`) remain **supported** tiers with disclosed levels — neither is
   declared unsupported, and neither is described as equivalent to the Unix
   path/syscall bar.
3. **A required level the tier cannot provide is refused.** The difference between
   levels is enforced by a typed refusal, never by a silent downgrade (`DEC-026`).
4. **Mechanism and residual travel with the level.** A record for a tier that confines
   a process carries `network_guarantee_level`, `network_mechanism`, and
   `network_residual` (`ARCH/23` §Data / state model), and the level is surfaced
   wherever a network-restricted profile is presented.
5. **History is preserved.** `DEC-008` is left exactly as written; this record is the
   read-through. A later decision supersedes `DEC-008` only where it says so.

**Where each of the five residual items is now governed.**

| Item | Tier-honest statement now in force |
|---|---|
| `REQ-VER-005` (`ARCH/02`) | The network sub-check asserts the tier's **declared** level per `ACC-P1-01(d)` — `enforced` proves `connect`-class denial with only `AF_UNIX` succeeding, `capability` proves a failing outbound attempt because the capability is absent, `best_effort` proves wrapped-process denial **and** that the residual is disclosed. The record stores `network_guarantee_level` / `network_mechanism` / `network_residual`; `ACC-P1-01(j)` is the refusal half. Linux `enforced` is the floor for a network-restricted profile. |
| `REQ-SEC-016` (`ARCH/02`) | Extension processes are confined with no ambient network **to the level the tier declares**, with the level, mechanism, and residual recorded and surfaced, and a stronger requirement refused. |
| `REQ-SEC-008` (`ARCH/02`) | Content still cannot create a rule, ticket, grant, or decision — and now explicitly cannot create, widen, or satisfy a **network** grant either; a network permission is a user act (`TB-0`) enforced at the declared level. |
| `AX-102` (`TODO.md`) | Linux tier 1 is the `enforced` tier and the level it must prove. The mechanism is stated as what it is: namespace isolation is the enforcement present in the current build (`bwrap --unshare-all` with the network namespace off); Landlock/seccomp stacking is still pending and namespace isolation MUST NOT be described as syscall-level denial. |
| `AX-119` (`TODO.md`) | Extension-process confinement declares the tier's level with its residual, and a caller requiring a stronger level is refused. |

**Rationale.** The residual was a wording layer, not a design layer: after `DEC-026` the
design was already per-tier, but four of the five items below still read as a single
uniform "network off", so a reader could conclude that every supported tier proves what
only Linux proves. That is exactly the over-claim `ARCH/22` §Purpose exists to prevent
("a **residual risk** so nothing is over-claimed"; `RR-07`, `RR-08`). The fifth item,
`REQ-SEC-008`, was not over-claiming — it was *silent* on network, which is its own
hazard: a requirement that says content cannot create "a grant" without saying which
grants are in scope leaves the network grant ambiguous. It therefore now states the rule
instead of inheriting it. Rewording to the tier where the statement is demonstrably true
keeps the strict floor where it is real and preserves the macOS and Windows capability
instead of declaring them unsupported. The requirement set is narrowed in wording only:
no control was removed, and the Linux bar is unchanged.

**Consequences.** `ARCH/13` §Network guarantee levels, `ARCH/22` `TB-6`/`N-06`/`X-05`
and the `REQ-SEC-008`/`REQ-SEC-016` mapping rows, and `ARCH/23`'s `REQ-VER-005` row cite
this record. `ACC-P1-01` already asserted the declared level and already required the
three record fields, so no acceptance row changed meaning.

**Governs:** `REQ-VER-005`, `REQ-SEC-016`, `REQ-SEC-008`; `TODO.md` `AX-102`, `AX-119`.
Evidence in `ACC-P1-01(d)` and `ACC-P1-01(j)` and gate `G-4`; residual risks `RR-07`,
`RR-08`. Tracked by `TODO.md` `AX-102`, `AX-113`, `AX-114`, `AX-119`.

## DEC-029 — One durable run controller with independent verification

**Decision (2026-09-27).** `CMP-orch` becomes the deterministic controller for a long-horizon run. It owns the task DAG, state transitions, budget reservations, leases, retry history, stop decisions, and recovery. `CMP-session` owns the canonical append-only run/task events and rebuildable projections; `CMP-runner` continues to own a bounded model turn. A runtime verifier is a separately authorized service invoked by the controller. Its result may be `PASS`, `FAIL`, or `INSUFFICIENT_EVIDENCE`; the worker cannot mark its own task passed. `ARCH/25` defines the records and transitions. A multi-process daemon is an optional deployment mode when detached work requires it, not a second scheduler or separate product core.

**Why.** `ARCH/16` currently unlocks dependencies when they merely settle, and `ARCH/07` has no durable task, attempt, evidence, or effect schema. Both allow false completion after a restart. The existing turn loop cannot close that gap by longer prompts. The independent evaluation role is supported as an experiment by [long-running harness research](https://www.anthropic.com/engineering/harness-design-long-running-apps), but its value must be measured on our own tasks.

**Alternatives.** A Markdown TODO cannot provide atomic claims or leases. A separate orchestration framework would duplicate the existing control plane and increase consistency risk. A permanent team of specialist agents is not required; the roles may run sequentially and are routed by measured need.

**Consequences.** `REQ-HORIZON-005..010`, `REQ-REPO-001..002`, `REQ-DELIVERY-001`; tasks in `TODO.md`. Priority is verified multi-hour completion, as the user confirmed. Latency, cost, and breadth remain measured constraints rather than reasons to weaken verification.

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

**Decision (2026-09-27).** The final product and GitHub repository name is
HorizonCode at `sarv-projects/horizoncode`. The executable is `horizoncode`,
internal crate prefix is `horizoncode-`, and new environment/config/state
names use `HORIZONCODE_*` and `~/.horizoncode`. Existing state is not moved
implicitly; `HORIZONCODE_HOME` can point at a previously created directory
when the operator intentionally resumes it. Historical Git commits, archived
documents and the current local checkout path retain their original identity.
Stable task IDs such as `AX-309` are not renumbered.

**Why.** The user named the final repository and requested a coherent rename.
Changing package and runtime identifiers together avoids shipping a new product
name with old binary, environment and persistence paths.

**Consequences.** Build metadata, source imports, CLI help, root documentation,
research notes and active architecture text use HorizonCode. The compatibility
choice for any publicly released predecessor remains an explicit migration
decision before release; no automatic state import is claimed.
