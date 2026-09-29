# CURRENT_RUN — HorizonCode

## Active handoff — architecture audit continuation (2026-09-29)

### Checkout and handoff status

Checked-out Git revision: `7e4b03d2d35d4a012827ea3980ec893b91768677`.
The reviewed Rust source baseline remains `23d4ce8`; the current working diff is
documentation-only. `TODO.md` contains 130 unique task IDs: 46 `implemented` and 84
`proposed`, with an owning architecture link and source-traceability link on every
row; none is `verified` or `accepted`. `TODO.md` is authoritative for the next
implementation task. Its current first action is AX-370, the source-confirmed guard
fix; older implementation queues later in this file are historical and must not
override that row or its dependencies.

Latest documentation-only checks: `git diff --check` passes; all 602 local links in
`TODO.md` resolve to files and anchors; `CURRENT_RUN.md` has no local links. The
active architecture/research link scan is recorded below. No product tests,
benchmarks, provider calls, or UI runs were performed. The documentation changes are
uncommitted. Preserve existing untracked workspace data.

### Current architecture/source reconciliation

The complete active architecture set (`ARCH/00–33`, with 17 intentionally unused) was
read in three non-overlapping line-by-line reviews and reconciled with requirements,
decisions, TODO, and source trails. Current fixes align the Thread model across
security, tools, orchestration, analytics, search, UI, artifact, update, and app-server
contracts; make provider fallback/cache semantics explicit; tighten the optional
unconfined grant boundary; and align the P1 acceptance matrix at 20 rows. Findings
F-84..F-90 add the broad legacy Yolo Ask conversion, pinned-provider fallback exposure,
malformed owner-lease acceptance, conservative unknown provider-capability semantics,
model-facing compacted-history retrieval, immutable adapter-build provenance, and
canonical question-batch arbitration. F-91 / DEC-071 / REQ-PROV-014 add an optional
provider-owned quota-observation store and read-only refresh path after the KiloCode /
CodeBurn audit; observations can drive visible warnings only, never routing or local
budget reservations. AX-386 records the LLD, settings/command surface, failure cases,
and test contract across ARCH/02, 04, 11, 20, 27, 29, TODO, and tests.md. The
LongHorizon-Harness launch-crash acceptance names reservation/run-directory and
process-launch/receipt windows. OpenHands SDK review found no new completion/effect
model to adopt; its replay measurements remain a separate storage microbenchmark.
F-23's overbroad secret-scanning guarantee was corrected to distinguish broker-held
credentials from arbitrary workspace text. AX-370, AX-384, AX-359, AX-360, and AX-328
own the implementation and acceptance work.

This remains a documentation/source audit, not implementation. Source-confirmed guard
defects are the external-path action mismatch and flattened rule-layer precedence; the
legacy Yolo posture also converts every surviving Ask to Allow, contrary to the
approved bounded grant. Source separately preserves global/project deny ceilings; do
not report those denies as bypassed. No product regression tests were added or run.
Documentation-only checks must be rerun against the current revision before handoff;
earlier QA counts belong to earlier commits and are not current evidence.

### Claude Code and subagent memory follow-up

Two requested bounded research passes completed (`/root/claude_public_arch` and
`/root/claude_mem_injection`). The Claude Code pass used official
public docs plus the README/license of `codeaashu/claude-code` solely to establish its
stated leak/unlicensed provenance; its `src/` and backup branch were not opened. No
leaked implementation was used. Official docs say ordinary subagents start with fresh
context, do not inherit parent transcript or auto-memory, and can receive explicit
skills and their own bounded profile memory. The claude-mem pass inspected its pinned
Apache-2.0 hook manifest plus public docs and historical/open issue reports; the hook
implementation and full source tree were not read. Its duplicate-memory reports are
version/setup-specific evidence, not proof that the defect persists at the reviewed
release.

The resulting target contract is recorded in `DEC-072`, `REQ-MEM-005..007`, and
`ARCH/09`, `ARCH/16`, `ARCH/18`, `ARCH/27`, `ARCH/33`: bounded per-child
`ContextPacket`; `fork=none` and profile memory off by default; no implicit parent or
sibling context; optional profile namespace in the existing memory store; explicit
policy/capability intersection; accepted/current/task-relevant records pinned to the
child `ContextEpoch`; candidate-only child writes; and visible source/usage disclosure.
The official `SubagentStart` hook can append context but cannot block spawn; it avoids
re-injection while the copy remains present and re-adds it after compaction. This is
recorded as adapter delivery behavior, while controller authorization and persisted
dispatch/epoch digests remain authoritative.
`AX-371`, `ARCH/29`, and `research docs/tests.md` now include the source limits,
implementation trail, and fan-out/isolation/recovery acceptance cases. No product
tests or upstream tests ran in this docs-only pass.

Current documentation checks: `git diff --check` passes. A local Markdown-link scan
checked 122 Markdown files; all 11 unresolved paths are in the pre-existing generated
notices/archive documents, while the changed architecture/research documents resolve.
No implementation tests or live-provider calls were run.

### Upstream source-review extension — scoped results

The current-turn OpenCode/Codex/Cline follow-up used per-file coverage ledgers where
available. **None was an exhaustive all-source-file read.** OpenCode pin
`083ed266e058dc3d2d1b377ff5540859d79de110`: 3,630 files in the declared source
extension inventory, 14 fully read, 10 partial, 3,606 unread. Codex local source
checkout `13a966fc652d1037c7ee93a15b2bdfa0610748ae` (not the research note's broader
pin): 6,291 source-like files, 9 fully read (786 lines), several partial, remaining
files unread. Cline pin `787ad1b077d8b697892dc3bfcd42e7c65b88789e`: 3,521 source/config
candidates, 16 fully read (4,118 lines), 8 partial, 3,497 unread. Exact citations are
in their research notes. Two detailed per-file ledgers are temporary audit artifacts,
not durable project files. No upstream tests, live UIs, or providers were run.

The user renewed the request for exhaustive source review across more named
repositories. Targeted read-only reviews are now complete for DeerFlow, DeepSeek Harness,
Superset, and OpenHands Agent Canvas. Durable ledgers are under
`research docs/source-audit-coverage/`; none was an exhaustive repository read. DeerFlow
selected 2,700 code files (10 full, 14 partial, 2,676 unread); DeepSeek Harness selected
5,484 (2 full, 9 partial, 5,473 not fully read); Superset selected 8,569 (8 full, 3
partial, 8,558 unread); OpenHands Agent Canvas selected 2,094 (4 full, 6 partial,
2,084 unread). The OpenHands UI checkout is not its runtime or benchmark suite. Codex
has no durable per-file ledger yet. Earlier notes for other named repositories are
focused research, not whole-tree reads. Claude Code has no published implementation
tree; official docs and the third-party `cc-haha` source remain separate evidence
classes. Do not claim all requested codebases were fully read.

The 2026-09-29 OpenHands software-agent-sdk pass read 8 files fully, 8 partially,
and inventoried 1,771 unread tracked paths; it is targeted, not exhaustive. The Kilo/
CodeBurn quota pass is also a focused source-path audit, not full-tree coverage. A
newer OpenHands/OpenHands Canvas pass pinned `94e156a8c7b7a468d7c60bda3a38757bfbfd4a79`
and inventoried 2,115 candidates: 27 full, 13 partial, 2,075 unread. It confirms that
frontend history paging, websocket resend, and optimistic state are UI catch-up
projections, not durable task/effect recovery; partial history remains visibly
incomplete, and browser localStorage API keys are not an acceptable secret-broker
pattern. No tests or benchmarks ran. The separately requested Ruflo/Nanobot/Hermes and
ECC/wshobson passes produced bounded focused reports after inventory startup. They are
now recorded in the source-audit coverage README and crosswalk, but none is exhaustive:
Ruflo 5/2,993 full/unread; Nanobot 4/21/1,224 full/partial/unread; Hermes
4/13/12,359; ECC 6/8/2,279; and wshobson 2/10/1,156. Their findings are limited to
the cited swarm, subagent, delivery, registry, catalog, hook, adapter, and installer
paths; no upstream tests or runtime commands ran. Do not generalize them to their full
repositories.

The 2026-09-29 crosswalk added three scoped architecture changes: optional current-Thread
history retrieval after compaction via the shared Thread index (AX-385); exact local
adapter build and negotiated-capability provenance with reconnect renegotiation (AX-318);
and an explicit question-call batch suspension state (AX-380). DeepSeek Harness's
route-specific in-history system-prompt replacement semantics are modeled as a
conformance-gated optimization; full prompt replacement remains the safe default. No
universal cache mechanism was added. Superset/OpenHands did not justify a new orchestration
subsystem; their current designs already map to AX-359/AX-318. Their event-array update
path only adds a large-history/streaming stress fixture to AX-374, not a reproduced bug.

Aider was refreshed against upstream `main` commit
`5dc9490bb35f9729ef2c95d00a19ccd30c26339c` (2026-05-22): its 691 tracked paths and
38 changed `aider/` paths since v0.86.0 were inventoried; the model, repo-map,
repository, command and base-coder deltas were inspected. The note distinguishes this
branch from the still-latest published v0.86.0 release and does not claim a full-tree
read. Claude Code has no published implementation tree; its official docs and the
third-party `cc-haha` workspace remain separate evidence classes.

The source review corrected Cline's nonexistent desktop/JetBrains source paths,
disabled-at-pin Agenda behavior, Team dependency edges, completion semantics, and the
limits of its subprocess/web-fetch boundaries (`F-83`). OpenCode research records
title-only/bounded search, update confirmation/signature differences, Go route diversity,
compaction loss, V2 deferred recovery limits, and strict local capability-validation
requirements (`F-87`). Codex research records non-atomic Goal/rollout persistence,
unbounded client event-queue behavior, message-board receipt semantics, and its
thread-scoped rather than task-verified goal model. Re-run documentation QA after any
further report-driven edits.

The currently confirmed target layout is **Explorer/editor on the left, chat fixed in
the center, and verified Tasks on the right**. All three regions resize through
splitters. Explorer and Tasks may swap side slots; chat cannot move, be replaced, or
close while active. Opening a file expands the Explorer/editor dock group. No permanent
bottom pane or second editor sidebar is planned. Earlier sections below that describe a
right-side editor or a movable chat are superseded historical notes, not current
requirements. `ARCH/06`, `DEC-066`, `REQ-UI-018`, `AX-374`, and the UI test plan own the
current contract. This is proposed design; the TUI is absent from source.

Distribution decision: **HorizonCode** is the product name; `hzcode` is the canonical
install/package/CLI name, and installed `horizoncode` is a compatibility alias to the
same app/state. New installation instructions use only `hzcode`. Dated npm and
crates.io exact-name lookups returned 404 on 2026-09-28; this does not reserve either
name. `ARCH/30`, update requirements, and AX-366 describe the target migration. The
checked-out binary is still named `horizoncode`; no code or package rename was made.

Conversation identity decision: `DEC-069` defines a durable HorizonCode `ThreadId`
plus separately recorded `WorkerExecution` incarnations. Protocol/provider `Session`
IDs are external bindings, not duplicate HorizonCode conversation IDs. The existing
`horizoncode-session` crate and session-named v1 files remain the persistence/migration
source; legacy IDs are preserved, and hash-chained event bytes must never be rewritten
in place. `AX-379` owns API/schema migration and compatibility acceptance. This target
model is not implemented in source.

### Thread identity contract check (2026-09-28)

The contract is now explicit in `REQ-SESS-008` and `ACC-P1-15`: a new process or
adapter execution under the same Attempt may continue the same Thread; a changed
task strategy creates a new Attempt and Thread. External ACP/provider Session IDs
remain adapter bindings, Thread parent/child links stay separate from the Task DAG,
and only verifier evidence can pass a Task. The permission bridge and run-to-turn
link examples now distinguish local `ThreadId` from external/control Session IDs.
`AX-379` owns the versioned, idempotent migration; `AX-359` owns durable live
execution and restart reconciliation. These are proposed target contracts, not
implemented code.

### Durable agent questions (2026-09-28)

Added `REQ-ORCH-010` / `REQ-UI-021`, `ACC-P1-16`, and `AX-380` for durable selectable
questions from an agent, including exact requester identity, typed answers, safe
pause/resume, idempotent receipts, accessible central-chat UI, and resumable headless
`NEEDS_INPUT`. Source inspection found a basic callback/options question tool, but no
answer validation, durable broker, TUI, or headless continuation. The added tests
cover malformed answers, crash/reconnect, adapter capability gaps, UI focus/draft
preservation, and the rule that answers never grant authority. This remains proposed;
the current tool does not meet that contract.

The first long-horizon harness review also identified a race invariant worth making
explicit: asynchronous evaluator output is stale if user input, cancellation, spec,
policy, task graph, or workspace revision changes before commit. Added
`REQ-ORCH-011` / `ACC-P1-17` / `AX-381`; controller revalidation must happen after the
inference and immediately before any state transition or dispatch. DeerFlow is the
pinned source pattern, but its LLM goal evaluator is not HorizonCode acceptance
evidence.

### External long-horizon and agent ecosystem review (2026-09-28)

Pinned read-only source reviews have been recorded in `research docs/` for DeerFlow,
LongHorizon-Harness, DeepSeek-Harness, DeepCode, Plandex, Ruflo, Kilo, ECC, Hermes,
Superset, CodeBurn, Nanobot, and wshobson/agents. Their reports distinguish observed
code from README claims and call out process-local state, stale quota caches, simulated
swarm paths, and benchmark scope. OpenHuman, OpenHands/SDK, AiderDesk,
DeepSeek-Reasonix, and tool candidates also have a source review. OpenChamber's active
timeline/sidebar search paths are now traced at its pinned revision; they search
materialized user-message/title records and do not establish full-history coverage.
The detailed note records exact source/test paths and the distinction from
HorizonCode's proposed FTS design. Superset's launch, binding, hook, transcript,
child-roster, and resume paths received a second pass; its resume-claim crash gap is
now an explicit HorizonCode recovery test. No source was copied, and no peer tests or
benchmarks were executed. Existing architecture already owns the key
budget, mailbox, terminal, usage, and provider-cache boundaries; test additions specify
their failure cases rather than creating duplicate systems.

Follow-up reviews added Kilo's quota/cache, soft warning, Agent Manager, and question
flows at its pinned revision, and found no local atomic budget authority in those
surfaces. The Warp/oh-my-pi and `ARCH/00..08` reports are now complete. Repository
reviews are focused path traces, not claims that every file in each large upstream
repository has been read.

Prior documentation QA snapshot (before the 2026-09-29 reconciliation edits): 66 Markdown files under `ARCH/` and
`research docs/` checked; 901 repository-local links and heading/HTML fragments pass
after URL decoding (`THIRD-PARTY-NOTICES.md` is excluded because SPDX identifiers are
labels); `git diff --check` passes; all 125 TODO task IDs are unique and each source
trail link/anchor resolves. The only root Markdown files are `AGENTS.md`,
`CURRENT_RUN.md`, `THIRD-PARTY-NOTICES.md`, and `TODO.md`. No build, automated test,
benchmark, provider call, or UI run was performed. `.code-intelligence/` and
`uipics/` remain untouched untracked user data. No staging or commit has occurred.

Review continued against checkout HEAD `a158cb4c24fae7118e373e637573678c05e90c42`
(docs only) and unchanged Rust source baseline `23d4ce8`. The OpenCode
UI/API comparison remains pinned to
`083ed266e058dc3d2d1b377ff5540859d79de110`. The old notes below are evidence/history;
they do not override newer user decisions or architecture records.

Continued the line-by-line architecture review at HEAD
`cbba87b9c6a33fc6faac31cdef9b38d2aae67243` against the unchanged Rust source baseline
`23d4ce8`. OpenCode TUI source was inspected at
`083ed266e058dc3d2d1b377ff5540859d79de110` for idle/home, prompt submission, active
tool/generation states, permission and question surfaces, child navigation, recent
history hydration, theme/preferences, and reconnect behavior. This was a source trace;
the peer TUI was not launched, and no usability or runtime-recovery claim is made.

The UI research note and `ARCH/06`, `ARCH/26`, `ARCH/29`, and `research docs/tests.md`
now capture the key boundaries: OpenCode renders only a recent 100-message window in
this route; that window is not whole-history search. Its UI omits a delivery mode while
the inspected V2 contract defaults to steering and also supports queueing. SSE
reconnect alone is not durable replay. HorizonCode search, queue receipts, explicit
status, and replay/gap behavior remain proposed.

Added `F-69..F-73` and `AX-370..AX-373` for the current-source external-path guard
action mismatch, policy-precedence verification, local-MAC versus portable audit
proof/effect recovery, memory-consent decisions, and implemented-versus-proposed
tool/skill capability reporting. The source-confirmed guard defect is critical and is
now the first bounded implementation item in `TODO.md`; it has **not** been fixed in
this docs pass. Added source-trail rows and tests-plan coverage. Clarified `AX-110` as
config-level discovery/digest-checked activation, while model-visible skill activation
is still absent. Pinned the Codex Goal/ThreadManager references to commit
`368e5eae2f006a70a91dddfdc96e6b2d11498f81` and kept the broad map and app-server README
at their distinct source pins.

Changed architecture/research/TODO/handoff Markdown only. No build, test, benchmark,
provider call, or UI execution was run. The following documentation QA passed on an
earlier snapshot: `git diff --check`, repository-local links/fragments, TODO task IDs
and source-trail anchors, and root Markdown layout. It does not cover subsequent edits;
the active review must rerun it on the final snapshot. The
generated third-party notices file was excluded from link parsing because its SPDX
license identifiers are labels, not repository-relative documents. Preserve the
untracked `.code-intelligence/` and `uipics/` user data; no staging or commit has
occurred. The earlier identity discussion is superseded by `DEC-069`: the target is
one durable `ThreadId` plus `WorkerExecution`. The
Codex/OpenCode mappings remain evidence-based comparisons, not a claim that HorizonCode
is implemented or superior.

## OpenCode provider and update architecture continuation (2026-09-28)

Earlier provider/update handoff details (superseded in status by the section above). HEAD is
`cbba87b9c6a33fc6faac31cdef9b38d2aae67243`; the reviewed Rust source baseline remains
`23d4ce8`, with no Rust-source or manifest difference between that baseline and HEAD.
The OpenCode source review is pinned to
`083ed266e058dc3d2d1b377ff5540859d79de110`; live official provider/Go documentation
and public catalog endpoints were checked on 2026-09-28.

A credential-free GET of `https://models.opencode.ai/api.json` at 16:30:47 UTC returned
225 provider IDs and 8,253 model records (5,214,814 bytes, SHA-256
`a03260a354cb2a97672eb582a94050a945762ad01890a368e69c4769755d69df`). A separate
credential-free GET of `https://opencode.ai/zen/go/v1/models` at 16:30:48 UTC returned
43 Go model IDs (3,569 bytes, SHA-256
`1464472961052aa41d454cce5c953d5fc3c68d7a2e19e95f7a6f41901d3b178a`). The global
feed's `opencode-go` provider record contained 33 models; official Go docs mapped only
30 current IDs to inference paths. Therefore Go model-directory presence is discovery
only: route path/protocol is local versioned data, and unknown IDs stay unavailable.
The current documented temporary zero-price examples are dynamic and still require a
Go account; the live inference acceptance waits for an implemented connector and a
user-authorized credential configured locally. No key was used or requested.

The inventory also distinguishes the 51 named provider-doc sections plus Custom, 32
pinned core integration modules, and supplemental auth plugins. It records each
provider ID in the dated global snapshot and all 51 documented setup/auth methods;
for additional IDs with no primary auth evidence the required state is explicitly
`unknown`, not an inferred API key or OAuth route. Remote env/package metadata is not
an auth/adapter authority. Exact endpoints, drift, sources, and method gaps are in
`research docs/opencode-provider-inventory.md`, `ARCH/11`, `ARCH/29`, and TODO
`AX-360..364`.

`ARCH/30-DISTRIBUTION-UPDATES.md` specifies one signed update service for startup
notification, `/upgrade`, and `hzcode upgrade`; settings, TUF bootstrap, install
ownership, safe maintenance, rollback, repair/uninstall behavior, and release scripts.
Notification is non-blocking; installation needs explicit operator consent and never
interrupts active work. Installer/update code is absent and no TUF client is selected.

The update CLI `--channel` override is one-command only; persistent channel selection
belongs to `/settings updates`. The helper that applies a staged update is a restricted
mode of the same signed HorizonCode binary, preserving `DEC-002`'s one-shipped-binary
contract. OpenCode Go docs say external coding agents should identify themselves and
send a stable session header, but HorizonCode is not in the current validated-client
list; any eventual test can establish local conformance only.

This pass changed architecture, provenance, test-plan, TODO, source-traceability, and
handoff Markdown only. Static documentation QA passed for 24 changed/new Markdown
files: local link targets, whitespace, newlines, exact inventory counts (225 provider
IDs, 51 documented auth/setup entries, 43 Go IDs, 30 documented routes), and
`git diff --check`. No build, code tests, benchmark, or live model-inference request
was run. No task status was promoted to implemented or verified. Preserve the
untracked user data in `.code-intelligence/` and `uipics/`; no staging or commit has
occurred. Next safe action: continue the overall architecture audit, beginning from
`TODO.md` and the owning `ARCH/` LLD; implementation of AX-360..366 remains proposed.
The follow-up concurrency review added `DEC-062` and `REQ-HORIZON-029`: system-wide
run admission, direct-turn/worker execution admission, and update maintenance must
share the durable `SupervisorControlStream` and cross-process lock. `ARCH/16`, `ARCH/25`,
`ARCH/30`, `TODO.md`, and the update tests now describe that fence and its crash
reconciliation; it is still proposed and no updater/controller implementation exists.
The 2026-09-29 docs-only link/status QA for the current snapshot is recorded in the
active handoff at the top of this file. Continue the upstream source audit and reconcile
any resulting architecture changes before treating the whole-architecture review as
finished.
Updated 2026-09-28 (second pass, same day). This handoff covers the **first
implementation wave** plus the closure of `F-66`/`AX-355` — the permission-seam defect
the first wave's test run exposed. It supersedes the documentation-only audit handoff
of 2026-09-27, which remains the record of what was read and why.

## Source-traceability correction (2026-09-28)

The user identified that owner-design links did not tell an implementing agent which
local code and exact upstream files to inspect. `ARCH/29-SOURCE-TRACEABILITY.md` now
records local entry points/tests and pinned peer-file references by design owner,
including explicit absent implementations and source-coverage limits. Every AX row
in `TODO.md` links to its first owner's source trail; additional owner links in that
row still apply. `AGENTS.md`, `ARCH/00` and `ARCH/26` require reading the trail and
rechecking paths at HEAD. This is documentation/navigation work only; it did not
change or verify runtime behavior. The trail was first recorded at documentation
commit `692eba1`; the latest reviewed source baseline is `23d4ce8`. The final
Codex/OpenCode comparison reviewed architecture status and official workflow/protocol
references, but did not run tests or promote any task to verified. Confirm the
checked-out revision again before implementation.

## Latest architecture comparison (2026-09-28)

The supplied OpenCode revision `083ed266e058dc3d2d1b377ff5540859d79de110` was
fetched and checked at the Session schema, Task tool, process-local background-job
registry, and V2 Session design. The source crosswalk now distinguishes durable
conversation identity from live execution. This paragraph records the earlier
comparison conclusion and is superseded by `DEC-069`: HorizonCode's target uses one
durable `ThreadId`, with `WorkerExecution` for each live process/adapter incarnation;
external ACP/provider session IDs are bindings only. The current implementation has
only the source-backed foundations listed in `ARCH/29`. `AX-359` owns execution
reconciliation and `AX-379` owns the migration to the Thread domain model.
Architecture, source-traceability, OpenCode research, TODO and test-plan records were
updated. These remain proposed design requirements; no runtime code or test was run
and no implementation/verification status changed. The exact peer sources and
comparison limits are recorded in `ARCH/26` and `research docs/opencode.md`.

The current doc-review changes are not a replacement for the remaining implementation
queue. Before coding, use `TODO.md` for the authoritative dependency order and recheck
the exact source revision; this handoff's older implementation-wave sections below
are historical context, not a live claim that those rows remain open.

## Prior implementation-wave goal (historical)

Deliver the first implementation wave that makes the session log and the audit chain
honest under inspection and crash, in dependency order, without adding a second
persistence path, permission system, or scheduler:

1. typed session enumeration that never reports a store failure as "no sessions" (`AX-353`);
2. read-only session paths that never truncate or repair a log (`AX-351`, read-only slice);
3. a commit durability profile with namespace durability and typed refusal (`AX-352`);
4. audit read/write integrity: read-only verification, access evidence outside the chain, typed head and enumeration failures, an OS-backed writer lock, explicit repair (`AX-346`, integrity slice);
5. the determinism and crash infrastructure the acceptance records require (`AX-122`, determinism/crash slice);
6. the permission seam: a read-only call is not denied by its own re-assertion, and one call records exactly one policy decision (`AX-355`, closing `F-66`).
7. provider-response admission owns tool-call id uniqueness, so a malformed batch is refused
   instead of surfacing as a per-call denial (`AX-356`).
8. the pinned audit genesis constants are reconciled with the labels they claim, with the
   pre-rename derivation recorded and refused (`AX-354`, closing `F-65`).
9. the first breadth slice: one configuration crate owns the discovery walk, the shared
   JSONC reader, the typed settings merge with provenance, and hierarchical `AGENTS.md`
   discovery; one `state_root()` resolves the documented `~/.horizoncode` fallback
   (`AX-008`, fixing `F-67` as `AX-357`).
10. the shipped third-party notices bundle: generated from the pinned dependency
   graph, embedded in the binary for `--credits`, and gated so a dependency change
   cannot ship stale attribution (`AX-010`).
11. the finite storage ceilings the segmented logs and artifact store need before
   they can be coded: published as `DEC-058`, carried by the config schema with
   lower-only validation, and exposed as typed limit views (`AX-348`, decision slice).
12. the shared segmented event-log core both session and run history need: canonical
   envelope, bounded segments with seals, committed head, streaming replay, version
   refusal, and preserved uncommitted tails (`AX-358`, the `AX-309` slice 1).
13. the typed slash-command registry and composer-reference parser: strict parse with
   suggestions, registry-generated help/search/completion, no fall-through to model
   text, and literal preservation for non-references (`AX-344`).
14. owner/mode/no-follow state-path hygiene applied through one shared primitive
   across the stores and the guard's policy config (`AX-126`).
15. skill discovery and progressive disclosure with a real frontmatter parser,
   metadata-only catalog, digest-verified activation, and a `/skills` surface
   (`AX-110`, first slice).
16. the artifact store's byte-admission core: bounded streaming writes, namespace
   quotas, digest-verified reads, and typed unavailable states (`AX-348`, first slice).

**Breadth program (user directive, 2026-09-28).** After the wave above, the user asked to
plan, check, and build the remaining proposed rows in dependency order without stopping
between them. The order is: `AX-008` (layered config + `AGENTS.md` discovery — the
prerequisite for nearly every other row) → `AX-010` (notices/provenance bundle) →
`AX-348` (bounded content-addressed artifacts, and publishing the finite
`session.log.*`/`run.log.*` defaults) → `AX-009`/`AX-344`/`AX-343` (TUI shell, typed
slash commands and `@` references, theme/accessibility settings) → `AX-110` (skill
discovery) → `AX-106`/`AX-332` (MCP client + schema filtering) →
`AX-112`/`AX-340`/`AX-341`/`AX-342`/`AX-304` (ACP client, agent directory, profiles,
per-agent model/quota visibility, peer pools) → `AX-320`/`AX-201`/`AX-202`/`AX-319`
(revision-bound repo index, tree-sitter map, LSP, context projection) → `AX-207`
(checkpoints/rewind, needs `AX-348`) → the governance and evidence rows
(`AX-119`, `AX-120`, `AX-121`, `AX-123`, `AX-124`, `AX-126`, `AX-307`, `AX-318`,
`AX-321`, `AX-329`, `AX-336`). Reconnaissance for the plan confirmed that none of these
subsystems exist today: no TUI/LSP/tree-sitter/WASM/MCP dependency, no artifact store,
no settings module, no notices bundle. The breadth vocabulary exists only as guard
policy words (`mcp.call`, `skill.install`).

## Where the work stopped

Starting point: Git `53a2654`/`b677443` (docs-only, Rust unchanged since `1c7a1c6`).
The Rust source has now been changed; the exact revision is the commit this handoff
travels with.

**Second pass — `AX-355` / `F-66` (permission seam).**

Three separate defects produced one symptom. Root-caused by reading the call path and
reproducing each cause independently:

1. `GuardPermissionGate::pairs` (`crates/horizoncode-tools/src/guard_gate.rs`) mapped a
   request naming **no resource** to an empty pair set, while the guard normalizes such a
   request to the wildcard and scopes its ticket to `**`. A `list` call with `{}` was
   therefore **allowed** by the rule and then **denied** by its own re-assertion, because
   the grant covered nothing. Grant bookkeeping now records the wildcard.
2. The call identity was only `(call_id, action)`. A tool-call id is a correlation token
   unique among the calls of one response, so an id reused later is a *new* call. Identity
   is now `(turn, call id, action)`: a reused id in a later turn is decided on its own
   merits, while a replay **inside** its issuing turn is still refused.
3. `AuditedGate::authorize` recorded a `policy_decision` for *every* pass, so the
   single-use spend appeared in the chain as a second outcome for the same call. The trait
   now has `consume` for the effect boundary, which spends the grant and decides nothing;
   one call records exactly one decision and the spend is ticket lifecycle.

`PermissionRequest` gained a `turn_id`; `PermissionGate::consume` defaults to `authorize`,
so a stateless gate is unchanged. The mock provider now mints a unique call id per
response, as a real provider does — that fixture defect is recorded as `AX-356` rather
than absorbed. Contracts updated in `ARCH/12` §Tickets + Interfaces and `ARCH/10`
§Permission assertion; `F-66` rewritten in `ARCH/24` as closed with its residual.

**Second pass, continued — `AX-356` (the residual of `F-66`).**

`ARCH/08` §Admit batch already required it: "on the completed response, validate IDs, schemas,
sizes, ordering metadata … a batch-level defect (invalid encoding/schema, **duplicate ID**,
oversized response, or stale workspace fence) dispatches none of its calls". Admission did not
implement the ID check, so a provider that reused a correlation id was refused deeper down, by
the gate, as if the *call* were being replayed. The runner now remembers the ids it has admitted
in a turn and refuses a response that repeats one, before the assistant message is appended or
anything is dispatched; the turn ends failed with a reason naming the id, recorded as a
`protocol` failure class (a new `FailureClass` value, additive). Tests: two unit tests over the
admission helper and an end-to-end test that drives a real duplicate-id response and asserts both
the typed refusal and that only one tool result exists. **Not covered:** an id reused across
turns of one session is still admitted; that history scan belongs with the run stream (`AX-309`).

**Second pass, continued — `AX-354` (`F-65`), the last red test.**

The bounded preimage spike answered the finding's question with exact matches: the pinned
constants are `blake3("agentx/audit/genesis/v1")` and `blake3("agentx/audit/roots/genesis/v1")`.
Neither side was a random typo — the constants were correctly derived from the *pre-rename*
labels, and commit `58569f4` renamed the labels without re-deriving them. The label is
authoritative: it is the format's documented identity and what a verifier recomputes. Both
constants are now `blake3(<current label>)`, the original assertions stay, and a new test in
each module pins the pre-rename value and refuses it
(`the_pre_rename_genesis_is_not_accepted_as_genesis`). The migration consequence is recorded
in `ARCH/14` §Genesis derivation: the pre-rename derivation was never shipped, and a store
that starts from it is refused at sequence 0 rather than accepted under a compatibility rule.
With this, the workspace has **no failing test**.

**Third pass — breadth program, first slice: `AX-008` (`horizoncode-config`).**

A new `horizoncode-config` crate is the one owner of discovery and validation
(`ARCH/18`): the layer walk (global first, then project outer-to-nearest, with a path
that exists but is unusable reported as an issue instead of being skipped), the JSONC
reader the guard now consumes instead of keeping a second copy, the typed settings
merge with per-key provenance (`SettingView`: requested/effective values, scope,
source, contributors, shadowed sources, validation error, apply boundary, schema
version, effective digest), and hierarchical `AGENTS.md` discovery with
canonical-path and digest dedupe, exact rendering, and the fail-closed unreadable
case. The first schema group is the small set this slice's consumers need
(`instructions.extra`, two accessibility flags, the terminal-bell preference); the
other `ARCH/18` groups register in the same registry as their owners land, so no
second settings engine appears. Building it surfaced `F-67`: all five state-root call
sites documented `~/.horizoncode` and implemented `$HOME`. `horizoncode_config::
state_root()` is now the one resolver (`$HORIZONCODE_HOME` → `~/.horizoncode` → `.`),
all three branches are unit-tested, and the session, audit, analytics, guard, and CLI
roots consume it (`AX-357`). Not covered here: injecting the rendered instruction
source into the assembled context is `AX-319`.

**Fourth pass — `AX-010` (third-party notices and the provenance bundle).**

`horizoncode notices generate` renders `THIRD-PARTY-NOTICES.md` from `Cargo.lock`
and the license/notice files of the package sources present for the generating
platform; the bundle is embedded in the binary, so `horizoncode --credits` prints
exactly what ships and works with no HOME, store, or provider. The gate is not byte
equality — which sources are unpacked varies by machine — but three rules: the
bundle's named lockfile digest must match `Cargo.lock`, every locked package must
appear and nothing else may, and every locally present package must be in the
resolved table with its shipped license expression and all of its notice texts. A
locally built package can therefore never be hidden in the unresolved section or
lose its notice. `horizoncode notices check` exposes the gate to a release script
(exit `1` when stale). The dependency allowlist (`G-1`) and `Adapt`/`Vendor`
provenance records are still open and named in the row.

**Fifth pass — `AX-348` decision slice: finite storage ceilings.**

`ARCH/07` and `ARCH/28` both said the numeric defaults were a pre-implementation
decision, and `AX-309`/`AX-350` are gated on them, so this pass publishes them as
`DEC-058`: per-record, per-segment, per-stream, control-reserve, replay-batch,
artifact inline/object/namespace, decoded media, retention, and orphan-grace values,
each finite and nonzero, with the segment numbers mirroring the audit store's
4,096-entry / 8 MiB precedent. The same decision records the durability posture:
Linux is the reference backend, macOS carries a declared contract, and Windows
cannot sync a directory through the standard API, so `run_durable` is **refused
typed** there rather than silently weakened. The `horizoncode-config` schema now
carries all 22 keys with the values as defaults *and* compiled ceilings, so a
configuration or project may lower a limit but never raise it and zero is rejected;
typed `LogLimits`/`ArtifactLimits` views are what the storage work will consume.
The artifact store itself (`BlobRef`, quota reservation, GC) is the next step in
`AX-348`, not this one.

**Sixth pass — `AX-358`: the shared segmented event-log core.**

`DEC-055` says session and run history use one bounded segmented framing, so
`horizoncode-eventlog` now implements it: the canonical envelope with a `blake3`
digest over a versioned domain and recursively sorted keys (`DEC-059`), segments
that rotate on the `DEC-058` ceilings, seals synchronized before a successor
segment receives a record, an atomically replaced committed head with typed
absent/malformed/unreadable states, an OS-backed writer lock, streaming replay
with a per-line ceiling, refusal of a newer schema version before any segment is
decoded, and bytes beyond the head preserved and reported rather than truncated.
The commit order is pinned by tests: a line is durable before the head
acknowledges it. The suite is 14 unit tests plus 12 log cases (round trip,
rotation by events and bytes, oversized and stream refusals, restart resume, torn
and complete tails, a corrupt sealed segment, the version refusal, a second
writer, an empty log, and a refused durability backend). The session store still
uses its single-file layout until the `AX-350` migration; run payloads and
projections are `AX-309`; tail recovery is `AX-311`. The notices gate did its job
on the dependency change: the regenerated bundle is part of this commit.

**Seventh pass — `AX-344`: the typed command registry and reference parser.**

`horizoncode-commands` now owns the registry both the headless surface and the
future TUI consume. Only commands whose owner exists are registered (`/help`,
`/commands`, `/usage`, `/insights`, each naming its owner and effect class);
unknown names return typed errors with nearest-name suggestions, malformed
arguments name the grammar, unavailable owners and unsupported surfaces are
typed refusals, and help, search, and completion are generated from the same
registry. The CLI's ad-hoc `/usage`-only parser is gone; `/usage` now takes no
arguments (the old `--all` was accepted and ignored, which is exactly the
plausible-no-op the architecture forbids). The composer-reference parser
recognizes the six namespaces, keeps bare `@name`, email, escaped, and
unknown-delimiter text literal, diagnoses unknown namespaces without blocking,
and supports quoted paths; parsing is never resolution and grants no authority.
Black-box tests prove the safety property: an unknown command exits `4` with
suggestions and prints no answer with no provider configured.

**Eighth pass — `AX-126`: state-path hygiene.**

One implementation (`horizoncode-config::state_fs`) now answers *is this path a
symlink, and is this file owner-only*: the stores and discovery walks refuse a
final-component symlink instead of following it, set `0600`/`0700` on what they
create, and the event log additionally refuses a lock or head whose mode grants
group/other access. It is applied to config layers, instruction files (a
repo-planted `AGENTS.md` link can no longer pull a host file into context — a
real exfiltration path), the session store, the analytics ledger, the event log,
the guard's policy config, and the audit store (which now consumes the shared
primitive instead of keeping its own copy). The residual is stated, not hidden:
Unix modes only, final component only, check/open TOCTOU, and no containment
claim — confinement remains `ARCH/13`'s job.

**Ninth pass — `AX-110`: skill discovery and progressive disclosure.**

`horizoncode-config::skills` discovers `SKILL.md` (or a sibling `<name>.md`)
under the global `<state>/skills` directory and the project walk, parsing real
YAML frontmatter with `serde_yaml_ng` instead of a bespoke subset. Only `{name,
description, slash}` enter the catalog; the body is returned only by `activate`,
which re-reads the file, refuses a symlink, re-parses it, and verifies its
digest against the listing so a file swapped after listing is a typed mismatch.
A malformed skill is a diagnostic and never a silent omission, and a nearer
skill of the same name shadows an outer one with the shadowed location reported.
Content is returned verbatim as untrusted data. The headless surface gains
`/skills [list | show <name>]`, which prints metadata and never a body.
**Not covered:** the enable/disable/archive lifecycle, context injection and its
budget (`AX-319`), remote provenance/signing, and plugin contributions.

**Tenth pass — `AX-348`: the artifact store's byte-admission core.**

`horizoncode-artifact` implements the write/read half of `ARCH/28`: `put` streams
from a reader, hashing and enforcing the `DEC-058` object and namespace ceilings
while it reads, so an over-cap payload is refused before it is buffered or
published; staging is exclusive and owner-only and publishes by digest, and an
existing digest path is re-verified rather than replaced. The per-namespace quota
ledger is durable, writes are idempotent by operation id with a typed conflict on
different bytes, and `read`/`stat`/`list` verify digest and length and return
typed missing/corrupt/unsupported/over-limit results. State paths go through the
shared hygiene primitive, so a link planted at an object, quota, lock, or
namespace directory is refused. The suite is 9 integration tests. What remains is
named in the row: leases and the owner graph, GC, decoders, export/import, the
physical reserve, and the session/run integration.

**Contract-first edits (architecture, before code).**

- `ARCH/07-SESSION.md`: exact `SessionListResult`/`SessionListEntry`/`SessionListIssue`
  payload, integrity derivation order, and the rule that only a store-level failure
  clears `enumeration_complete`; a new *Commit durability backend* section (profiles,
  the `sync_file`→`sync_dir`→acknowledge order, refusal conditions); a dated source-status
  block for the read-only split, stating that `recover(...)` is still unimplemented.
- `ARCH/15-PROTOCOLS.md`: session-listing result/error mapping, including that a
  `session/list` is not advertised until implemented and tested, and that no surface may
  substitute "no sessions" for a failed scan.
- `ARCH/14-AUDIT.md`: dated source-status block for the access stream, typed head,
  refusal on torn tails, and the OS-backed lock, with the remaining work named.
- `ARCH/24-ARCHITECTURE-REVIEW.md`: a dated implementation-pass section, plus **F-65**
  and **F-66** (see below).
- `research docs/tests.md`: the determinism/fault-injection/kill-matrix inventory, the
  quarantine policy, and the baseline failure list with what each test proves.

**Source changes.**

- `crates/horizoncode-types/src/clock.rs` (new): the injectable `Clock` trait,
  `SystemClock`, and `system_clock()`. Production code no longer reads the host clock
  directly; the session store takes an `Arc<dyn Clock>`.
- `crates/horizoncode-testkit` (new crate, dev-only): `TestClock`, `ScriptedFaults`/
  `FaultOp`, `StoreSnapshot` (byte-level before/after proof) and the kill-point
  environment contract. It is a dev-dependency of test suites and is never linked into
  the binary. `ARCH/03`/`ARCH/07` note the non-product crate in prose.
- `crates/horizoncode-session/src/durability.rs` (new): `DurabilityProfile`, the
  `CommitSink` seam (`supports_run_durable`, `sync_file`, `sync_dir`), `StdCommitSink`,
  `UnsupportedSink`.
- `crates/horizoncode-session/src/listing.rs` (new): the typed listing contract, the
  integrity enum, the issue kinds and payload, and `SessionListResult`.
- `crates/horizoncode-session/src/store.rs`: one pure `scan_log` behind
  `read_only`/`scan`/`inspect`/`list`; `list` returns `SessionListResult`; `inspect`
  reports a present-but-unreadable log; `latest` prefers a readable session; `create`/`append`
  commit through the durability profile; the torn-tail truncation moved behind the
  documented repairing path and no longer appends a repair event.
- `crates/horizoncode-session/src/error.rs`: `HeaderMissing`, `HeaderCorrupt`, `Durability`.
- `crates/horizoncode-audit/src/access.rs` (new): the independent access-evidence stream
  with its own sequence, `blake3` chain, ownership/mode checks and OS lock, plus a
  chain-verifying reader.
- `crates/horizoncode-audit/src/store.rs`: the writer lock is taken before head/segments
  are read and held for the store's lifetime; the head is read as
  `Absent | Present | Malformed | Unreadable`; a torn tail refuses an ordinary open;
  `AuditLog::repair_segment` is the explicit, byte-preserving repair with a linked
  recovery artifact; `segment_indices` returns typed errors; the head replace syncs its
  directory entry.
- `crates/horizoncode-audit/src/error.rs`: `HeadInvalid`, `HeadMissing`, `RecoveryRequired`,
  `StoreLocked`.
- `crates/horizoncode-cli`: `audit repair --segment --output`; access recording moved to
  the access stream and is required **before** any read; new exit code `7`
  ("the audit access record could not be written, so nothing was disclosed"), documented in
  `--help` and asserted against it.
- `Cargo.toml`: `rust-version` 1.88 → 1.89, because the OS-backed lock uses
  `std::fs::File::try_lock` and no process-lock dependency was added.

**Tests added or changed.**

- `horizoncode-session/tests/list.rs` (8), `tests/read_only.rs` (8),
  `tests/kill_matrix.rs` (1 test, 20 cycles × 5 crash points, real child processes).
- `horizoncode-audit/tests/integrity.rs` (10), `tests/writer_race.rs` (1 test, 20
  two-process cycles).
- Three existing tests were changed because they asserted the behaviour this pass removed:
  an audit census test that held two writers open at once; a census test that counted a
  read as chain coverage; and an exit-code test whose negative control relied on `verify`
  creating the store it reads.

## Checks run, at this revision

- `cargo fmt` for every file this pass wrote or changed: clean
  (`cargo fmt -p horizoncode-session -p horizoncode-audit -p horizoncode-cli -p
  horizoncode-types -p horizoncode-testkit`). The **workspace as a whole is not
  rustfmt-clean at the baseline**: `cargo fmt --all --check` reports 67 pre-existing
  diffs, including two inside crates this pass touched
  (`horizoncode-audit/src/redact.rs`, `horizoncode-cli/src/approval.rs`). Those
  reformats were deliberately reverted rather than bundled into this wave, so
  `cargo fmt --all --check` is a pre-existing failure here and must not be reported as
  a pass. Formatting the rest of the tree is its own cleanup task.
- `cargo clippy --workspace --all-targets -- -D warnings` — pass.
- `cargo test --workspace --no-fail-fast` — **508 passing, 0 failing** at this revision
  (the count grows with the new suites; the totals above are per-run, not additive across
  passes). The two `F-65` genesis failures measured at baseline `b677443` are fixed under
  `AX-354`; the two `F-66` failures measured earlier in the day went green under `AX-355`.
- `cargo test -p horizoncode-config` — 28 tests: 7 unit (JSONC edge cases, the three
  `state_root` branches), 4 discovery, 11 settings/provenance (including the
  `DEC-058` defaults table, the lower-only/zero refusals, and the typed limit views),
  6 instructions.
- `cargo test -p horizoncode-eventlog` — 26 tests: 14 unit (envelope canonicalization
  and verification, seal digest coverage, content digest, head states/versions) and 12
  log cases.
- `cargo test -p horizoncode-commands` — 18 tests over the registry (owners, uniqueness,
  documented arguments, refusals with suggestions, help/search/completion, surface
  gating) and the reference parser (namespaces, quoting, escapes, spans, diagnostics).
- `cargo test -p horizoncode-cli --test commands_cli` — 6 black-box cases: help/list
  without a provider, an unknown command exiting `4` with suggestions and no output, a
  malformed argument naming the grammar, and an unknown help topic.
- `cargo test -p horizoncode-cli` — includes the notices gate: 5 unit tests (the
  generator's lock parsing, rendering, determinism, and the four refused edits) and 3
  black-box tests (`--credits` with no configuration, `notices check`, `notices
  generate --output`).
- Baseline comparison was performed in a clean worktree at `b677443`; no test that passed
  there fails here.
- One unreproduced flake was observed once and not in 11 subsequent runs:
  `horizoncode-audit` `chain::a_recomputed_merkle_root_matches_the_signed_root_and_a_tampered_root_fails`.
  It is reported rather than dismissed, because a flake re-opens the requirement it covers
  (`ARCH/23`).

## Known limitations of this pass

- `ACC-P1-12` is satisfied only in its read-only and enumeration halves. Explicit
  recovery (`AX-311`) and the index rebuild (`AX-350`) are still missing, so a torn tail is
  retained and reported rather than reconciled.
- `ACC-P1-13` is satisfied at the ordering and refusal level only. Real ENOSPC and power
  loss need an isolated fixture and explicit authorization; they are `insufficient
  evidence`, not passes. The advisory lock is per-host-filesystem and does not claim
  anything about NFS.
- `ACC-P1-04` is satisfied for read-command non-mutation, typed read failures, access
  receipts and writer locking. The global `audit_seq`/`segment_seq` migration, per-effect
  prepare/terminal reconciliation, device-key rotation and the tamper matrix remain
  `AX-346` remainder / `AX-311`.
- `run_durable` currently promises namespace durability of the **event log** only: no
  segmentation, no committed head file, and no physical control/recovery reserve yet.
- Fuzz targets, corpora and seeded-RNG coverage of provider retry jitter (`AX-122`
  remainder) are untouched.

## Decisions and gotchas

- `std::fs::File::try_lock` is the OS-backed lock, which is why the workspace MSRV moved to
  1.89 and why no new dependency (and no license-gate entry) was needed. `flock`-style
  advisory locks do not help across NFS; records must name the filesystem they were proven on.
- Holding the audit writer lock for the store's lifetime changes the contract for callers:
  two `AuditLog::open` calls on one store in one process are now a typed `StoreLocked`
  refusal, not a silently tolerated second writer.
- The access ledger holds its lock for the ledger's lifetime too, so a test that wants to
  read receipts while the CLI still runs must use `read_receipts(path)` (no lock) instead of
  opening an `AccessLedger`.
- `record_access` runs *before* every read, so an unwritable access stream makes `verify`,
  `replay` and `census` exit `7` with no output. That is deliberate: disclosure without a
  durable record of disclosure is the outcome the access ledger exists to prevent.
- The session `load()` path still repairs (truncates) a torn tail. It is now documented as
  the repairing path and is not reachable from any read-only surface, but it is **not** the
  `recover(session_id, expected_head, recovery_id)` the architecture specifies; that
  operation remains `AX-311`.
- `latest()` returns the newest **readable** session, so `--continue` no longer silently
  resumes a corrupt session.
- A tool-call id is a correlation token, not a globally unique identity: scoping grants to
  `(turn, call id, action)` is the fix that makes an id collision across turns stop denying
  legitimate calls, while in-turn replay protection is unchanged. Any test that builds two
  requests for "the same call" must give them the **same** turn, or it is testing two calls.

## Implementation queue from the prior coding wave (recheck TODO before acting)

0. Decide whether to format the rest of the tree in its own change, so the documented
   `cargo fmt --all --check` baseline becomes enforceable (`AX-121` builds the gate that
   would catch this). Every file this handoff's passes touched is `rustfmt`-clean; the
   workspace-wide check still reports the 67 pre-existing diffs.
1. Recheck the current checkout and `TODO.md`; this architecture review has a
   documentation diff, and the user-owned untracked `uipics/` and `.code-intelligence/`
   must remain untouched.
2. The **`AX-350` session migration** onto `horizoncode-eventlog`: bounded
   digest-linked segments, committed head, streaming replay, event-byte quota and the
   protected control reserve, keeping the read-only/typed-enumeration contract stable.
   The run-log half waits for `AX-309`/`AX-312`.
3. Then the rest of `AX-348` (reference leases and the owner graph, GC with the
   incomplete-scan abort, decoders, export/import, the physical reserve, and the
   session/run integration); then the TUI and settings surfaces
   (`AX-009`, `AX-343`), which consume the command registry and the `/skills`
   surface, then MCP (`AX-106`, `AX-332`) and the plugin/WASM rows. `AX-010`,
   `AX-344`'s headless half, and `AX-110`'s first slice are done; their remaining
   work is named in their rows, and `DEC-058`'s numbers may be revised only by a
   new decision.
4. `AX-311`: the effect journal, which unblocks `AX-351`'s recovery half and gives
   `ACC-P1-06`/`ACC-P1-12` their recovery evidence.
5. Then the rest of the controller chain (`AX-301`, `AX-310`, `AX-312`, `AX-313`,
   `AX-317`, `AX-337`, `AX-347`) before any multi-hour claim. The remaining breadth rows
   (agent directory and ACP client/pools, repo map/LSP, checkpoints/rewind,
   host probe, config recovery, peer adapters, delegation measurement,
   eval/perf, safety/config/provenance) follow in the dependency order recorded in
   §Active goal.

## Unresolved questions

- ~~Which side of F-65 is authoritative~~ Resolved 2026-09-28: the label is authoritative,
  the pre-rename derivation is refused, and the migration consequence is recorded in
  `ARCH/14` (`AX-354`).
- ~~Whether provider-response admission should reject a duplicate call id or repair it~~
  Resolved 2026-09-28: reject, before dispatch, with a typed reason (`AX-356`).
- How the `DEC-058` numbers perform on real workloads: they are published ceilings,
  deliberately conservative, and may be revised only by a new decision with a
  schema-version note. No benchmark has run yet.
- Whether `AX-350`'s session migration needs a format-version bump for the segmented
  layout: the session header currently names `CURRENT_FORMAT_VERSION`, and the new
  stream carries its own `CURRENT_SCHEMA_VERSION`; the migration must define how the
  two relate before it lands.
- The `DEC-058` `session.log.*`, `session.artifacts.*`, and `run.log.*` finite defaults
  are chosen. AX-348 implementation and workload/platform validation remain open and
  gate the relevant AX-309/350 slices.
- Whether the segment/head format (`AX-350`) needs a format version bump for the durability
  backend, given that no head file exists yet.

## Commits in this wave

One commit per coherent unit; the session and audit changes each touch a single
large file, so they are not split further for the sake of a commit boundary.

1. `docs: specify typed session enumeration, durability profile, and read-only boundary`
2. `feat(harness): add an injectable clock and a test-support crate`
3. `feat(session): add typed enumeration, byte-preserving reads, and a durability profile`
4. `fix(audit): record access outside the chain and refuse unverifiable store state`
5. `feat(cli): add the audit repair surface and the access-record exit code`
6. `docs: record the implementation pass, the measured findings, and the handoff`
7. `fix(guard): stop denying a read-only call at its own effect boundary`
8. `docs: close F-66 and record the admission gap it exposed`
9. `docs(review): mark the findings wave 1 actually addressed, and say what remains`
10. `fix(loop): refuse a provider batch that reuses a tool-call id`
11. `fix(audit): re-derive the genesis constants from the labels they claim`
12. `docs: close F-65 with the spike evidence and the migration note`
13. `feat(config): resolve layered settings, instruction discovery, and one state root`
14. `docs: record the config slice, F-67, and the unified state root`
15. `feat(cli): ship and gate the third-party notices bundle`
16. `docs: record the notices bundle and its gate`
17. `feat(config): carry the storage ceilings with lower-only validation`
18. `docs: publish the finite storage ceilings before the storage code`
19. `feat(eventlog): add the shared event envelope and commit durability backend`
20. `feat(eventlog): add bounded segments, a committed head, and streaming replay`
21. `docs: record the shared segmented event-log core`
22. `feat(commands): add the typed slash-command registry and reference parser`
23. `docs: record the command registry and the reference parser`
24. `feat(state): refuse symlinked state paths and keep owner-only modes`
25. `docs: record the state-path hygiene slice and its residual`
26. `feat(config): discover skills with digest-verified activation`
27. `docs: record the skill slice and what it does not cover`
28. `feat(artifact): add bounded content-addressed byte admission`
29. `docs: record the artifact slice and what remains`

Each commit is self-contained and builds; commit 2 carries the workspace manifest,
so its body notes the MSRV move that commit 4's OS-backed lock depends on.

## Worktree preservation

The user-owned untracked `uipics/` and `.code-intelligence/` are preserved and were not
staged. No remote was touched, nothing was pushed, published, or deployed, and no
production data was changed. Two temporary baseline worktrees were created under
`/tmp/opencode` for the failure comparison and were removed.
