# MiMo-Code — OpenCode fork with long-running-agent extensions

> RESEARCH SNAPSHOT — reviewed 2026-09-27. The v0.1.15 release is pinned at
> `14dfe68`; post-release main-branch PRs are discussed separately because they
> may not be in that binary. This is a focused source/contract review of the agent,
> memory, context, workflow, and runtime-boundary features. It is not a complete
> line-by-line audit of the monorepo or proof of every README claim.

## Direct answer: is it just an OpenCode clone?

It is explicitly an OpenCode fork. MiMo-Code's README says it retains OpenCode's
multi-provider support, TUI, LSP, MCP, and plugins, then adds durable memory,
context management, task tracking, subagents, goal-driven loops, compose workflows,
and dream/distill maintenance. So its base is not independent evidence against
OpenCode; its value is the *delta*: how a large agent runtime is extended with
continuity and orchestration features, and what operational failures appear at those
new boundaries.

The project has also begun to diverge in session processing, tool scheduling, recovery,
provider handling, and UX. The correct comparison is therefore upstream OpenCode versus
a moving fork, feature by feature and at matching revisions. Do not label every current
MiMo behavior as upstream OpenCode behavior.

## Evidence and version boundary

- The README describes the product and names the OpenCode fork relationship. It is a
  project statement, not verification of every behavior.
- The v0.1.15 release is dated 2026-09-22 and pins commit `14dfe68`. Its release notes
  describe ordered gating for same-step tools, a tool-call flood guard, and improved
  session recovery. It does not include every later main-branch fix.
- The Sep 21 PR #2463 added a 16-call generation barrier and excess-call cancellation.
  Its author reports local regression tests/typecheck; the report is evidence of that
  PR's intended behavior, not our independent verification.
- The Sep 22 PR #2484 describes limiting flood recovery to two attempts, stopping on
  the third, persisting a visible error, and retaining the budget across successful
  steps. It was closed, but a later PR #2487 changed the recovery approach by allowing
  one call from a flooded response; inspect the exact release/tag before adopting either.
- PR #2487's own notes explicitly say repeated flooding could still execute one call
  per response and that it did not impose a recovery-attempt limit. PR #2514/#2515 then
  proposed removing the generation barrier/quota and executing streamed tool calls with
  same-step deduplication. Those changes demonstrate fast design iteration, not a
  settled invariant.
- GitHub's release page lists v0.1.15 as released Sep 22. Issues opened around the
  release report behavior seen in v0.1.14 or local builds; keep the version on every
  bug observation.

Sources: [MiMo-Code README](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/README.md),
[release history](https://github.com/XiaomiMiMo/MiMo-Code/releases), [tool-flood
PR #2463](https://github.com/XiaomiMiMo/MiMo-Code/pull/2463), [bounded recovery
PR #2484](https://github.com/XiaomiMiMo/MiMo-Code/pull/2484), [first-call recovery
PR #2487](https://github.com/XiaomiMiMo/MiMo-Code/pull/2487), [later streaming/dedup
PR #2514](https://github.com/XiaomiMiMo/MiMo-Code/pull/2514), [follow-up PR
#2515](https://github.com/XiaomiMiMo/MiMo-Code/pull/2515).

## HLD and main subsystem map

The inherited runtime remains centered in `packages/opencode`; the repo also has
provider/model integration, a server/API, SDKs, a SolidJS web/desktop client, a TUI,
plugins, and bundled skills. MiMo additions sit inside and alongside that runtime rather
than forming a separate autonomous supervisor that is independent of the session loop.

| Subsystem | Publicly documented behavior | HorizonCode reading |
|---|---|---|
| Session/runtime | OpenCode-derived session and tool loop with provider-specific adapters | Continue studying the request, stream, tool, retry, compaction, and completion transitions at matching commits. |
| Persistent memory | Markdown project/session/task files plus SQLite FTS5 indexing; README describes `MEMORY.md`, checkpoint, notes, and task progress | Files are inspectable and portable; search index is a projection that must be reconciled after changes/crashes. Separate memory truth from run/task truth. |
| Context management | Automatic checkpoints, reconstruction from checkpoint/memory/task progress/recent messages, importance-ranked token budget, per-model compaction thresholds | Useful projection/retrieval pattern. Persist source revision/digests and provenance; don't inject stale memory or treat a checkpoint summary as canonical event history. |
| Task tracker | Hierarchical IDs (`T1`, `T1.1`); documented states include open, in progress, blocked, done, abandoned | A checklist/task tree is useful for visible work decomposition, but task status must be independent from verification and cannot alone satisfy acceptance. |
| Actor/subagent runtime | Background spawn, run/wait/status/cancel/send; README advertises lifecycle tracking and background execution | Track actor process/session as an `ExternalAttempt`; completion of spawn or tool call is not worker completion. Retain status, timeout, cancel outcome, permissions, workspace revision, and opaque usage. |
| Goal stop condition | `/goal` plus a separate judge that evaluates whether the goal is satisfied when the agent attempts to stop | Useful anti-premature-stop signal; the judge is still model output. A deterministic controller must own stop/continue and bind completion to evidence. |
| Compose/workflows | Compose handles spec-to-delivery; deterministic JS workflows chain phases, bounded retries, parallel tasks/worktrees, reports | Distinguish conversational workflows (human can redirect) from unattended deterministic workflows. Give each phase a typed output and independent gate. |
| Dream/distill | Dream promotes trace patterns into project memory; distill proposes reusable skills, agents, or commands | Treat generated memory/assets as untrusted proposals; require source citations, dedupe, conflict checks, expiry, user review, and rollback. |
| Settings/skills | JSON/JSONC with schemas, global/project layering, built-in and cross-agent skill roots | Reuse schema-generated settings/completion ideas; preserve source, capability, trust, and effective-value visibility. |
| Server/TUI | `mimo serve` plus `mimo attach`; README recommends local rendering over SSH when direct TUI animations lag | Do not adopt remote attach for the current HorizonCode scope: the user clarified SSH is for Git. Local same-host attach can inform supervised lifecycle tests; remote UI needs a separate future requirement, threat model, auth protocol and acceptance. |

## Long-horizon data and flows

### Memory and context

The documented model stores readable Markdown files for project memory, session checkpoints,
notes, and per-task progress, with SQLite FTS5 used for searchable indexing. The high-value
pattern is to keep durable notes inspectable and let an index accelerate retrieval. A
searchable index alone does not guarantee complete or fresh knowledge: reconciliation,
file deletion, renames, concurrent writers, stale FTS rows, large note files, path
migration, and failed writes all need defined behavior.

Context reconstruction draws from the latest checkpoint, project memory, task progress,
and selected recent messages under a model-specific token budget. The README says the
configured maximum is clamped to the concrete model's accepted window, and offers a
per-model compaction threshold. This is better than assuming a model's advertised context
is the usable context on every route. For HorizonCode, probe the effective server/model/
template capacity, reserve output/recovery room, show the effective budget in settings,
and include retrieval provenance and age in the run record.

### Tasks and actors

The task tool exposes create/list/get/start/block/unblock/done/abandon/rename operations.
The documented lifecycle is small and useful for human-visible tracking, but it does not
include a distinct verification state or prove that `done` tasks passed. HorizonCode's
DAG should retain separate `implemented`, `verifying`, `passed`, `needs_review`, and
`blocked` semantics, with evidence bound to spec digest and tested commit.

The actor tool supports background spawn, blocking run, status, wait, cancellation, and
messages. The tool guide warns that a spawned child completion notification does not
necessarily wake the parent, and `wait` on persistent peers may never return a normal
successful terminal outcome. Therefore, a HorizonCode scheduler should consume explicit
status events and deadlines, not infer status from tool-part completion or await an
unbounded promise. Cancellation must reconcile in-flight writes before workspace reuse.

### Goal and workflow

The independent goal judge addresses optimistic stopping, while compose/JS workflow phases
provide repeatable execution. These are complementary, not interchangeable: a model judge
may assess a natural-language stop condition, while deterministic workflow code can enforce
phase order and retry ceilings. Neither alone establishes user intent, task evidence,
provider spend, policy, or safe crash recovery.

Workflow files are executable code, not harmless Markdown. The project says these run in
an isolated workflow runtime, while the Codex microkernel note clarifies that QuickJS
isolation does not turn real Bash into an OS sandbox. Any workflow that can invoke shell,
filesystem, network, MCP, or an agent must request those effects through host-enforced
capabilities, and the host must enforce its own limits.

## Codex-oriented tool runtime

MiMo documents a GPT/Codex tool profile that exposes a smaller ABI (`bash`, `apply_patch`,
`view_image`, `exec`) on the shared session engine. The `exec` tool composes filtered host
tools in QuickJS; permissions, paths, subprocesses, persistence, cancellation, and UI remain
host-owned. This is a sound *composition* pattern when tool filtering is applied before
composition and every nested call returns through the same host validator.

The authors explicitly clarify that “microkernel” is an architectural analogy, not an
OS microkernel. QuickJS isolates guest JavaScript from Node APIs; Bash is still a real
shell, not a container. Never present a guest script runtime as command sandboxing. The
same note documents separate string-based prompt/tool-profile selection rules, which can
drift; HorizonCode should use one capability-negotiated model profile rather than parallel
heuristics.

Source: [Codex-oriented runtime note](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/docs/architecture/codex-microkernel-runtime.md).

## Failure reports worth turning into regression fixtures

These are repository issue reports and PR histories. They are concrete failure scenarios,
not independently reproduced HorizonCode defects or universal claims about current releases.

| Report / change | Failure mode | HorizonCode design/test |
|---|---|---|
| [#2482](https://github.com/XiaomiMiMo/MiMo-Code/issues/2482), with [#2463](https://github.com/XiaomiMiMo/MiMo-Code/pull/2463) | Thousands of non-adjacent/rotating tool calls in one generation bypass an adjacent-identical-call detector; a call-count cap alone still leaves repeated response retries. | Bound response tool count, total argument bytes, retained output bytes, and generation duration; cap the stream buffer; persist rejected-batch fingerprints and retry budget across model/session changes. Never execute the same rejected batch again without a strategy change. |
| [#2475](https://github.com/XiaomiMiMo/MiMo-Code/issues/2475), [#2484](https://github.com/XiaomiMiMo/MiMo-Code/pull/2484), [#2487](https://github.com/XiaomiMiMo/MiMo-Code/pull/2487), [#2514](https://github.com/XiaomiMiMo/MiMo-Code/pull/2514) | A whole-batch cancel can erase useful results and induce identical retries; allowing a prefix may make progress but executes partial work and complicates semantics. The alternative streaming/dedup approach has its own partial-execution and accounting tradeoffs. | Keep admission semantics explicit. Default HorizonCode policy is buffer-and-validate a bounded complete response, then dispatch; over-cap means dispatch none. Return a durable typed result, preserve usage when known, and circuit-break repeated rejection. If a future adapter explores safe-prefix execution, it must be a separately tested capability with per-call receipts, ordering semantics, and non-replenishing recovery budget. |
| [#2474](https://github.com/XiaomiMiMo/MiMo-Code/issues/2474) | A user reports that a broad “allow always” decision suppressed future loop prompts and allowed repeated successful Bash calls. | Never let an approval shortcut disable loop safety. Guard authorization and run-loop control are separate gates; “always” rules do not override no-progress or attempt bounds. |
| [#2502](https://github.com/XiaomiMiMo/MiMo-Code/issues/2502) | An open report describes approval controls becoming unresponsive after automatic interruption/orphaning. | Priority-lane pause/cancel/approval input, interruption-safe modal cleanup, orphan-request settlement, and terminal UI tests after cancellation/flood stop. |
| [#2504](https://github.com/XiaomiMiMo/MiMo-Code/issues/2504) | A headless command printed its final answer but then silently waited for a background checkpoint writer before exit. | Separate foreground completion from bounded background checkpoint drain; show a machine-readable `maintenance_pending` state or deadline, do not mislabel it as active task progress, and preserve eventual checkpoint durability. |
| [#2123](https://github.com/XiaomiMiMo/MiMo-Code/issues/2123) | A user reports mixed-generation message IDs sorting lexically and breaking prompt/UI order after upgrade; the report points to upstream OpenCode parent-ID ordering fixes. | Use monotonic sequence/causal parent relations, not lexicographic IDs or wall-clock ties, for canonical event order. Include mixed-version ID migration and replay fixtures. |
| [#1481](https://github.com/XiaomiMiMo/MiMo-Code/issues/1481) | A user reports `context="full"` subagent spawn missing the fork context and ending with unknown/no output. | Validate context mode at request admission; materialize the selected history snapshot before spawn; return typed `unsupported_context` or `missing_snapshot`, never an ambiguous unknown terminal. |
| [#2535](https://github.com/XiaomiMiMo/MiMo-Code/issues/2535) | A user reports accumulated large base64 images causing provider request failure in a long session. | Store large attachments as artifacts, send only provider-compatible referenced media per task, account for bytes/tokens, and compact/remove stale media only with preserved source references. |

For the flooding changes, test the policy alternatives against scripted streams and effects.
Do not infer from a PR's test report that HorizonCode's chosen policy is superior.

## What to borrow, and what to improve

| MiMo/OpenCode pattern | Disposition for HorizonCode | Required improvement |
|---|---|---|
| OpenCode provider/model/plugin/TUI base and extension surface | Study as architecture, not as a second independent baseline | Keep HorizonCode's own control-plane and adapter contracts; check every copied line against `docs/research/SOURCE-LEDGER.md`. |
| Human-readable memory files plus local FTS search | Adopt the split concept | Canonical versioned facts/events separate from generated summaries; provenance, source revision, age, contradiction and deletion reconciliation. |
| Per-model context/compaction budget and token-aware status | Adopt | Probe effective route limit; reserve completion room; record compaction epochs; settings expose source/effective value; warn before stale or unverified retrieval. |
| Background actors with cancel/status/wait | Adopt with stricter supervision | Persistent task ownership, deadline, lifecycle event stream, fenced worktree, capability/usage snapshot, cancellation reconciliation, independent acceptance. |
| Goal judge | Use only as an advisory evaluator | Deterministic controller decides; stop requires evidence; no-progress circuit breaker and explicit user pause survive restart. |
| Bounded deterministic workflows and worktrees | Adopt for repeatable proven paths | Each phase has a typed contract; bounds enforced by host; require fresh results and merge verification; keep an interactive route for ambiguity. |
| Dream/distill self-improvement | Gate behind explicit review | Proposals cannot write trusted memory or executable skills directly; adversarial source review, provenance, diff, tests, approval and rollback. |
| QuickJS `exec` composition | Prototype only if tool-call overhead is measured as a bottleneck | Tool allowlist cannot widen through nested calls; no false OS-sandbox claim; cap calls/bytes/time/memory; use the host guard for every effect. |
| TUI over SSH | Defer from current product contract | SSH is for Git. Do not add remote attach assumptions to local host deployment; future remote access requires explicit product/security design. |

The project license is reported as MIT, but the README separately points to MiMo use
restrictions, hosted-service terms, and trademark policy. Those terms are not themselves
the software license, and they do not grant rights to bundled dependencies or assets.
Before reusing source, inspect the exact tagged files, notices, contributions and
`docs/research/SOURCE-LEDGER.md` compatibility policy. Prefer independently written implementations from
recorded behavior unless source reuse is deliberately approved.

## Primary sources

- [Repository README](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/README.md)
- [v0.1.15 release (commit `14dfe68`)](https://github.com/XiaomiMiMo/MiMo-Code/releases/tag/v0.1.15)
- [Repository security model](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/SECURITY.md)
- [Codex-style QuickJS tool runtime](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/docs/architecture/codex-microkernel-runtime.md)
- [Actor tool contract](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/tool/actor.txt)
- [Task tool contract](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/tool/task.txt)
- [Config and local state reference](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/skill/builtin/.bundle/mimocode-docs/reference/config.md)
- [Flood issue #2482](https://github.com/XiaomiMiMo/MiMo-Code/issues/2482)
- [Flood retry issue #2475](https://github.com/XiaomiMiMo/MiMo-Code/issues/2475)
- [Approval/loop report #2474](https://github.com/XiaomiMiMo/MiMo-Code/issues/2474)
- [Checkpoint wait report #2504](https://github.com/XiaomiMiMo/MiMo-Code/issues/2504)
- [Message ordering report #2123](https://github.com/XiaomiMiMo/MiMo-Code/issues/2123)
