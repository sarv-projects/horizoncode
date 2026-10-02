# HorizonCode dependency-ordered implementation playbook

This guide defines the implementation method and dependency order for the final
HorizonCode target. It is not a second task ledger: **TODO.md owns task IDs, statuses,
dependencies, and current gaps; ARCH/ owns target contracts; research docs/tests.md
owns test and benchmark procedures; CURRENT_RUN.md owns the exact working revision
and handoff.** Use the task’s owner links and source-trail links in TODO.md before
changing code.

## Governing method

Work in dependency order. A prerequisite’s observable contract and evidence must be
ready before dependent work uses it. Feasibility, source presence, a worker report, a
passing mock, or a benchmark score cannot weaken an ARCH requirement or promote
implementation status.

Every bounded work item follows this lifecycle:

1. **Design** — read its TODO row, owning HLD/LLD, requirements, source trail, tests,
   and dependencies. Record intended behavior, affected schemas/interfaces, user
   flows/settings, security/resource effects, failure cases, and acceptance evidence.
   Update ARCH first when a required contract is absent or ambiguous.
2. **Implementation** — implement one authoritative owner/path. Preserve the explicit
   capability and failure states; do not add duplicate registries, schedulers, stores,
   permission engines, or UI state owners.
3. **Focused tests** — prove ordinary behavior and exact boundaries at the owner layer.
4. **Failure tests** — exercise malformed, denied, stale, cancelled, interrupted,
   resource-exhausted, and partial/unknown outcomes applicable to the change.
5. **Integration tests** — exercise real owner boundaries and end-to-end event/effect
   ordering with deterministic fixtures. A mock alone is not integration evidence.
6. **Benchmark/regression** — compare against a recorded baseline; include correctness,
   responsiveness, resource use and regression outcomes. Faster incorrect work fails.
7. **Independent evidence** — bind reports to exact integrated source/spec revision,
   build, environment, platform, command, raw result, limitations, and verifier. The
   implementer’s completion message is not independent verification.
8. **Status reconciliation** — update the existing TODO row, acceptance record, test
   inventory and CURRENT_RUN handoff. Only an independent verifier may promote a row
   to `verified`; only its acceptance record may promote it to `accepted`.

Parallel work is allowed only with explicit non-overlapping write scopes, satisfied
prerequisites, bounded resources, cancellation and independent review. Keep source
truth and evidence tied to the exact revision; never merge stale baseline claims into a
newer HEAD without reinspection.

## Phase 0 — truth, feasibility and product-fit gates

Complete the gates in this order. They establish reliable starting evidence; they do
not delay urgent safety repairs in Phase 1.

### P0.0 — clean-clone and CI health (AX-001, AX-121, AX-399)

Inspect the checked-in tree and CI from a fresh clone. The current index contains a
`cline-probe` gitlink (mode `160000`) and no `.gitmodules`; the nested checkout is
dirty. Treat its intended role as unknown until repository history, CI references and
a fresh-clone check establish it. Do **not** claim it breaks checkout or CI without
that evidence. Do not modify, reset, or remove the nested checkout during diagnosis.
If the gitlink is intentional, add reproducible source metadata without touching the
nested work; if accidental, remove only the superproject gitlink while preserving the
working directory. Then prove a fresh clone reaches checkout, dependency policy,
build, Clippy, tests, and architecture checks. Record the exact revision and all
skipped platform/hosted checks.

### P0.1 — reconcile repository truth (AX-325)

At the exact current HEAD, reconcile TODO, CURRENT_RUN, source traceability, acceptance
records, task statuses and evidence references. Inspect current source rather than
relying on a historical summary. The previous architecture/source baseline
`262bdb2fb8a2fef86d885a6c83ea49bae38bfcde` is historical; the planning HEAD for this
plan is `7441b79191aa645ad0deda0341bb67dbd9c51b8a` (2026-10-02). Results recorded from
a dirty tree or an earlier revision remain explicitly historical until rerun or
otherwise bound to the integrated revision. Do not promote statuses during a ledger
reconciliation without current acceptance evidence.

### P0.2 — architecture contract gate (AX-413..AX-418)

The documentation update in this planning revision added the AX-413..418 target
contracts to their canonical owners: the language boundary; index service and
manifest/generation/freshness; model-facing repository APIs and `TaskPackage`;
worktree overlays; deterministic `ChangeReceipt`; worker inheritance/integration;
and bundled skills. It also added linked requirements, acceptance cases, scale
workloads and test-plan entries. This gate is complete after the final audit and
commit of these documents. Keep AX-413..418 `proposed` until their runtime work and
evidence exist. Implementation must recheck these owners and amend them only when a
specific contract is missing or ambiguous; do not repeat the design addition or
create a second TaskPackage or repository-index owner.

### P0.3 — build the evaluation harness (AX-419)

Implement `hz-eval` and the HZBench development/holdout split before tuning the
intelligence or fast scheduler. Every evaluation captures benchmark/task/repository
revision, harness revision, model/provider/reasoning settings, prompt and tool-schema
digests, environment digest, limits, trajectory reference, timings, tokens/tool/model
call counts, verifier result, outcome, and limitations. Development cases are visible
during iteration; holdout cases are versioned and frozen, access-controlled, and never
tuned against. Keep raw failures and uncertainty in reports. Harness semantics and
`ACC-EVAL-01` are already in the canonical evaluation owner; implement against them
and amend that contract only if source inspection finds a specific gap.

### P0.4 — record B0 before optimization

Capture paired baseline runs using the same task, model, provider, reasoning settings,
repository, environment/network rules, tool/step/time/spend ceilings and verifier.
Measure accepted tasks per model call, pass/regression rate, tokens (including cached
when observable), rounds, tools, repeated reads/search, failed calls, patch retries,
test runs, context size, wall time, usage/cost and uncertainty. Record Horizon versus
OpenCode on exact same-model routes where both are genuinely available. Model offers,
prices and route behavior are time-sensitive evidence and must be rechecked at run
time; live calls require authorized credentials. The named OpenCode Go comparison
requires the Horizon route work in AX-360/AX-361 and may additionally require AX-364
and account authorization. If unavailable, record the missing comparison and do not
invent a zero-cost or equivalent route.

B0 is an optimization gate, not a blocker for correctness/security repairs in Phase 1.
Before Phase 4 enables repository-index or Code Mode optimizations, either run the
supported paired B0 or record the unavailable-route blocker. A preregistered
fixture baseline can support mechanics development, but cannot waive coding-quality
evaluation or justify adopting an optimization on product-quality grounds.

The initial tracked Phase 0 tasks remain AX-124 (partial headless performance harness),
AX-362 (verified pinned OpenCode/Cline source inventories), and AX-399 (verified Cargo
DAG/boundary gate). Their statuses are scoped to the evidence in their TODO rows;
AX-124 does not establish TUI paint/idle/cancel/index performance, and AX-362 does not
prove Horizon provider routes.

Also conduct representative developer sessions for quick edits and long tasks. Observe
time to first useful result, blocker understanding/resolution, review/correction effort,
recovery, perceived smoothness and confidence in verification. Public sentiment and
competitor features form hypotheses, not product-market-fit evidence.

## Phase 1 — shared runtime and safety foundations

Keep the urgent AX-314 patch-preflight safety interleave before the remaining AX-005
transport-cancellation assertion, as recorded in TODO. Do not hold correctness or
security fixes behind B0. Finish the existing AX-001/003/004/005/006/007/008/010,
AX-101..105, AX-113..118, AX-121/122/125/126, AX-314..316, AX-328/329/334/338/339,
AX-346/351/352/354..358, AX-370 and AX-405 tasks against their owners. Prove whole
response admission, typed schema and duplicate-ID rejection, cancellation, bounded
reads/search, patch preflight/partial receipts, provider/SSE bounds and failure
handling, guard/approval ordering, real sandbox reach, audit/redaction/secret custody,
state-root hardening, and platform-specific limitations.

Use adversarial/fault fixtures for oversized and malformed responses, partial streams,
disconnects, cancellation races, symlink/path escapes, huge searches, output overflow,
filesystem/process failure, and denied late patch targets. A deterministic fault-injection
substrate is required for relevant ENOSPC, access-denied, kill, network, provider,
corrupt-state, timeout, clock/reboot and child-process failures. Do not claim parity for
an unsupported platform. Record B1: correctness and effect-safety non-regression,
crash/error outcomes, and bounded operations.

### AX-408 staged evidence

Keep one AX-408 ledger row and status. Record two separate evidence subjects:
(1) the early rolling scheduler, exclusivity/order/revocation/cancellation contract;
(2) optional isolated Code Mode and its correctness/effect/resource-equivalence gate.
A scheduler-only result cannot verify Code Mode or promote the whole combined row.
Code Mode stays disabled without its separate evidence; a partial implementation
must name the unfinished stage in the existing ledger row and handoff.

## Phase 2 — durable state, effects and budgets

Finish AX-309, AX-311, AX-312, AX-350, AX-002, AX-348, AX-353, AX-379, AX-372,
AX-109, AX-382 and AX-302. Establish one canonical event/owner chain:

`Goal → Run → Task → Attempt → Step → Effect → Evidence`.
This is a dependency/observation path, not a containment schema: the canonical domain
model owns identities and cardinalities, and evidence may verify several subjects.

No model prose is canonical state. Fault-inject before/after prepare, effect, receipt,
terminal event and cross-store commit. Settled effects never replay accidentally;
unknown remains `UNKNOWN`; response loss is not operation failure; retries need
idempotency or reconciliation proof. Budget by Goal/Run/Task/Attempt/child/tool batch
and reserve execution, verification and recovery separately. Record B2 normal and
interrupted completion, recovery success, duplicate effects, replay bounds and recovery
calls/tokens.

## Phase 3 — managed Run controller and workspaces

Finish AX-120/317/301/310, then AX-395 WorkspaceProvider/environment snapshot and
AX-313 writer fencing/integration before enabling overlays or concurrent writers.
Continue AX-112/318/359/337/345/347/335/397/381/326/331/367/368 according to their
explicit TODO dependencies. Persist original intent/spec/acceptance and task DAG;
controller alone selects CONTINUE, CHANGE_STRATEGY, WAIT, PAUSE, STOP or COMPLETE.
PASS unlocks dependents; stale evidence, worker `done`, elapsed wait, or budget
exhaustion cannot become success. Exercise attach/replay/cancel/restart and unknown
worker outcomes. A workspace adapter contract must prove Git is one provider, not a
kernel requirement.

B3 is a multi-hour understand → plan → multi-file edit → test → diagnose → repair →
verify task with interruption. Measure completion, duplicate work, model/recovery
calls, plan drift, evidence completeness and premature stops.

## Phase 4 — model/context/repository intelligence and model-call reduction

Task mapping: AX-107/305/307/319/320/324/327/201/202/203/206/333,
AX-360/361/364/384/369/371/375/385/400/110/308/373/383/349/408,
and AX-414/415/416/417/418. These are existing single ledger entries;
the subsections below define their dependency stages rather than replacement tasks.

Honor the order below. AX-395/313 workspace snapshots and fences precede AX-415
worktree overlays. AX-311 durable effects and the revision/index pipeline precede
AX-417 ChangeReceipt. Keep existing AX-201/202/320/375/400 tasks as the implementation
owners they already are; AX-414..417 extend those contracts instead of duplicating them.

1. **Revision and manifest foundation (AX-320/375/400, AX-414).** Define
   `WorkspaceRevision` from canonical workspace identity, committed/base revision,
   dirty manifest, editor-buffer digest where available, file ID/path/language/size,
   BLAKE3 content identity, exclusion/generated/vendor status, parser/grammar and
   index generation. Index is rebuildable derived state, never repository truth.
2. **Supervised index service (AX-414).** Build `horizon-indexd` as a separate Rust
   child supervised by HorizonCode. It may start asynchronously so the composer is
   ready; it is not an unsolicited detached daemon, listener or second controller.
   Give it bounded typed IPC, cancellation, restart/reconciliation, queues and resource
   governor. Logical modules: scanner, watcher, manifest/digest, parser, symbol store,
   graph, lexical index, query, scheduling, storage and health.
3. **Change detection and incremental indexing (AX-414).** Preferred evidence order:
   exact Horizon edit event; exact editor-buffer delta; Git transition hint; watcher
   dirty event; periodic/recovery reconciliation; BLAKE3 content digest as final
   validation. For create/update/delete/rename, update only affected records; use
   incremental Tree-sitter only with an exact edit delta, otherwise reparse that file.
   Never rescan millions of LOC for one-file edits.
4. **Background priority/resources (AX-414).** Reserve P0 for control/cancel, P1 for
   interactive queries, P2 for active-file updates, P3 current-task neighborhood, P4
   dirty-file indexing, P5 initial scan, P6 embeddings/deep enrichment. Cap parser and
   embedding workers, disk rate, CPU/RAM, compaction and storage. Typing/streaming must
   retain control and query service; embeddings may pause.
5. **Structural then lexical indexes (AX-201/320/414).** Add Tree-sitter definitions,
   signatures, imports/exports, scopes and approximate syntax relationships; label
   syntactic edges. Keep ASTs in a bounded hot cache rather than persisting every full
   tree. Add bounded local lexical ranking (e.g. SQLite plus one measured lexical
   engine) for paths, identifiers, symbols, terms and selected docs. Avoid premature
   multi-database architecture.
6. **Semantic enrichment (AX-202/400).** Add LSP/SCIP definitions, implementations,
   references, call hierarchy and diagnostics after structural/lexical paths. Label
   authority distinctly; never call syntax approximations compiler-resolved truth.
   Optional embeddings are a later ablation, off by default, with pinned model,
   tokenizer, dimensions, quantization and generation. Keep them only if holdout gains
   justify CPU/RAM/disk and complexity.
7. **Worktree overlays (AX-395/313 → AX-415).** Share an immutable base index pinned
   to a base revision plus one changed/new/deleted-file overlay per workspace. Resolve
   overlay first, base second. Do not copy full indexes to workers. Integration
   advances the main overlay generation only after controller validation; stale,
   conflicted, or unknown generations fail closed.
8. **Query planner and model-facing APIs (AX-416; extend AX-375/400).** Classify
   exact symbol/text, definitions/references, impact/tests, conceptual and mixed
   questions; choose the cheapest sufficient source. Expose bounded `repo_query`,
   `repo_context`, `repo_impact`, and `repo_expand` in the existing registry/Guard path.
   `TaskPackage` reuses the canonical `ContextPacket`/TaskPackage model in
   ARCH/core/CONTEXT.md: bounded revision-pinned files/symbols/tests/dependencies,
   diagnostics, recent changes, ranges, handles, index generation and workspace
   revision. Never inject the index itself into model context. Every result carries
   workspace/revision/generation, source method, freshness, coverage and limitations.
9. **Deterministic ChangeReceipt (AX-417).** After a coherent edit settles, deterministically
   apply the authorized path: index delta → formatter → diagnostics → affected-test
   discovery → allowed targeted checks → diff → impact → evidence. Return one bounded
   receipt with generations, changed files/symbols, diagnostic/format/test results,
   diff/impact, and items still unverified. Test selection is advisory; required
   verification can expand. A receipt, passing formatter, or successful command never
   marks Task PASS.
10. **Context, skills and scheduler (AX-319/373/418/408).** Feed only ranked, bounded
    repo projections to context, with progressive overview → symbols/signatures → exact
    ranges → nearby tests/dependencies. Activate selected skills progressively, not
    all bodies. Add the first-party SWE/architecture/agile library under AX-418 only
    after skill activation/revocation lifecycle AX-110/308/373; artifact skills remain
    AX-411 and are referenced, not implemented twice. Safety-critical AX-408 rolling scheduling, barriers and cancellation are
    foundation work in Phase 1, extended through the effect/guard owners as needed.
    Finish this phase with optional isolated Code Mode evaluation after effect,
    guard, context and isolation foundations. Keep Code Mode evaluation-gated and disabled where its
    safety/effect equivalence is not proven.

Benchmark B4 through AX-419: accepted-task quality and regressions, model rounds/tokens,
repeat reads/search, wrong-file edits, tool calls, test runs, time, RAM/CPU/disk, index
size and UI interference. Ablate raw filesystem tools, structural, lexical, LSP/SCIP,
graph/task context, embeddings, TaskPackage, ChangeReceipt, skills, scheduler and
workers. Never improve efficiency ratios by reducing correctness.

Repository-index acceptance must include security/exclusion for `.git`, generated,
vendor, binary/oversized, symlink, denied, secret-like and external-root files; explicit
schema/parser/grammar/intelligence/embedding version migration; pinned grammar
provenance (no runtime download/load of arbitrary grammar code); watcher overflow to
STALE plus bounded reconciliation; result provenance/freshness; affected-test selection
limits; restart/rebuild and index-health reporting. The index cache cannot bypass
`read` authorization.

Scale workloads are 10K, 100K, 1M, 5M and 10M+ LOC. Measure initial indexing,
one/100-file updates, huge checkout, branch switch, symbol/lexical/hybrid queries,
RAM/CPU/disk/index size, overflow/restart recovery and UI frame/input interference.
Derive numeric targets from an exact baseline in ARCH/contracts/PERFORMANCE.md;
never invent a threshold. The simultaneous usability gate includes 5M LOC background
indexing while a response streams and the user types.

## Phase 5 — agents, workers and delegation

Finish AX-340/341/342/204/205/303/304/336/380 after the Phase 3 controller and Phase 4
context/index overlay contracts they consume. Profiles receive explicit Task,
success criteria, bounded TaskPackage, tool loadout, model, budget, write scope,
workspace and index overlay. No uncontrolled transcript/index copies. External
capability/usage/cancel/resume fields remain unknown unless observed. Child `done` is a
candidate only: integrate through the controller, update the main index, then obtain
independent verification. Compare a cheap model alone/with Horizon/workers against a
strong model on accepted tasks per call/token/cost/tool/minute; account for fan-out
and verification costs.

## Phase 6 — direct coding product and TUI

Task mapping: AX-009/108/207/322/323/343/374/344/387/406/402/388,
AX-208/401/403/404/396/389/390/391/392/409/411/377.

Build in increments: (1) fixed composer, streaming, tool rows, diff, approval, cancel,
status and command palette; (2) editor bridge, symbol navigation, live diff,
file/worktree explorer and artifact viewer; (3) managed Runs/Tasks, agents, Needs You,
evidence, recovery, budgets and workspace state; (4) layout presets, resize, themes,
syntax/images, accessibility, reduced motion, screen reader, durable queue, branches
and side questions. Retain exactly three resizable primary slots; modes adapt their
content without adding a persistent fourth pane.

AX-406 acceptance includes incremental stream painting, batching/coalescing, smooth
scroll, syntax highlighting, interruptible selection/overlay animation, zero replay
animation and idle animation wakeups, reduced/off motion, ANSI/NO_COLOR fallback,
focus and draft preservation, keyboard/pointer parity, slow terminals and bounded
visible-row rendering. Exercise 80×24, 120×30, large displays, resize during stream,
100K-line history, large paste, cancel, permission midstream and accessible operation.
The stress combination is 5M LOC background indexing + active streaming + typing; index
work must yield to input, approval and cancel. Use sole numeric budgets in
ARCH/contracts/PERFORMANCE.md. AX-401 owns artifact navigation/review; AX-411 owns
artifact skills.

## Phase 7 — integrations and ecosystem

Finish AX-365/363/106/332/111/119/306/376/394/407/393/378/398/386. MCP supports
stdio/Streamable HTTP, tools/resources/prompts, pagination, cancellation/reconnect,
lazy schema discovery and policy filtering. Extensions pass through the existing
catalog/manager, Guard, sandbox and audit; no second policy, scheduler, catalog or
verification authority. Preserve LitePSM lifecycle ownership. AG-UI is an edge adapter
only after ControlService, not a replacement controller.

## Phase 8 — packaging, onboarding and release acceptance

Complete AX-321/123/330/366/410/412. Doctor reports observed capability state, not
catalog presence or configured intent. Install/update/onboarding acceptance covers
Ubuntu/macOS/declared Windows mode, fresh install/upgrade, corrupt or interrupted
package, disk-full, PATH consent, package-manager ownership, rollback, offline startup,
existing config, provider setup Skip/Back/resume and secret handling. Use signed Bash
and PowerShell bootstrap/update paths with explicit user consent.

Run final benchmark tracks: **A** same model/harness-controlled (Horizon/OpenCode),
**B** each product’s suitable current configuration (product ceiling, not harness-only
causality), and **C** Horizon ablation. Maintain visible HZBench-Dev and untouched
HZBench-Holdout suites for quick edit, repo understanding, feature build, test
engineering, refactor, terminal ops, long run, crash recovery, context/compaction,
stop/no-progress, multi-agent, permission/security, workspace conflict, provider
failure, PR/verification, repo scale and model-call efficiency.

Release candidate requires fresh-clone/CI green; executable evidence for every claimed
capability; no unresolved unknown effects in acceptance runs; honest platform limits;
recovery and long-run acceptance; TUI performance while indexing; holdout executed per
frozen rules; failures retained; and TODO/CURRENT_RUN/acceptance records bound to the
release commit. Release does not imply every optional capability is available on every
platform.
