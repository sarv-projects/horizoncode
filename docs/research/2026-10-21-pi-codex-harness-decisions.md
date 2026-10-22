# Pi and Codex harness patterns for HorizonCode

**Reviewed:** 2026-10-21  
**Status:** comparative design decision; source implementation and acceptance remain governed by the V1 phase trackers.  
**Authority:** `arch_V1/` is normative. This note records external patterns and the decision to reuse, adapt, or defer them; it does not create a second runtime.

## Decision summary

HorizonCode already has the main architecture needed to combine these patterns: Core owns direct Sessions and context compilation; Rust owns managed Tasks/Attempts, Guarded effects, leases, receipts, recovery, and verification; the TUI renders bounded projections. The work is to finish these contracts and their wiring, not add Pi Durable or Codex as another execution engine.

| Pattern | Decision | HorizonCode application |
|---|---|---|
| Pi resource loading, project instructions, skills, prompt templates, and dynamic context | **Adopt the progressive-disclosure behavior; keep Horizon owners.** | Core `ContextService` compiles a bounded, revisioned `ContextSelectionV1`. Resolve instructions/skills/templates from trusted scoped sources, include provenance and digests, and load large skill bodies only when selected. Dynamic context changes become explicit request-bound revisions. Never let a plugin inject ambient context outside selection policy. |
| Pi compaction and long histories | **Adopt the recovery behavior.** | Compact at a request boundary, preserve original history, retain exact prompt/profile/tool revisions seen by each request, and recover from summaries plus canonical history. Summary generation is advisory and cannot change accepted criteria or evidence. |
| Pi session trees, timeline navigation, and forks | **Adopt local branch navigation through the existing Core Session owner.** | Preserve parent-entry identity and branch lineage; a fork gets an immutable history prefix and its own continuation. Use Horizon timeline/fork APIs and UI. Do not add a Pi transcript store. HTML export may be a local, redacted, user-triggered feature; hosted sharing/gist upload is deferred because it creates an external disclosure path. |
| Pi queued steering vs follow-up | **Adopt explicit delivery mode.** | Distinguish queue-only message from a message that wakes a child turn; preserve the parent turn/message correlation and idempotency key. A queued message alone never implies provider dispatch. This matches §29.5 and the lane-tagged `SubagentDeliveryV1`. |
| Pi Durable ownership tree, task checkpoints, idempotent request IDs, replay safety, snapshot-on-attach, and usage attribution | **Adapt the invariants, not the framework.** | Keep one Core direct Session and one Rust managed owner. Persist intent before effects, classify replay safety, use exact idempotency identities, reconcile ambiguous effects to `UNKNOWN`, derive UI state from owner snapshots plus fenced deltas, and attribute nested model/tool cost to the originating call. Do not import its experimental TypeScript runtime, SQLite/JSONL authority, generic execution environment, or hooks that can bypass Guard. |
| Pi CodeMode | **Keep HorizonCode CodeMode; adopt bounded composition and progressive tool discovery.** | Scripts may compose, filter, and parallelize already authorized tools/models under byte/time/call limits. Every nested effect must pass through Rust Guard/ExecutionHost with the same Attempt, lease, consent, and receipt rules. Keep CodeMode unavailable until P1 integration and acceptance. Never expose a callback executor as a bypass. |
| Deferred tools and extension-provided virtual models | **Adopt only as explicit registry metadata and user-selected capability.** | Tool discovery may reduce prompt size but cannot broaden authority. Model extensions may describe non-chat tasks (for example image/classifier) only through the existing provider/model registry and a profile-pinned request; no hidden routing or silent provider changes. These are not grounds for a second provider registry. |
| Pi model catalog and models.dev | **Keep models.dev as HorizonCode's existing catalog source; do not add a parallel Pi catalog.** | Use catalog context, modality, and price as attributed metadata with freshness. Runtime availability, auth, capabilities, and actual usage come from the selected provider route. Unknown stays unknown; no fallback provider is selected implicitly. |
| Pi prompt-cache warming | **Defer automatic warming.** | It creates additional model traffic and cost without user work. If later offered, require explicit opt-in, selected-route cache lifetime evidence, estimated savings/cost, cancellation, and usage accounting. Default remains off. |
| Pi analytics/footer and Codex trace/task visibility | **Adopt the useful presentation.** | Show selected model/provider, token and cache usage, cost quality, elapsed time, and live child/task state in compact UI with bounded detail views. Preserve provenance (`reported`, `measured`, `estimated`, `unknown`); never convert missing data to zero. A task tree is a projection, not a second scheduler or evidence store. |
| Codex parallel delegation | **Adapt explicit scoped delegation and nonblocking lifecycle.** | Independent work receives a clear deliverable, bounded context, exclusive write scope, capacity reservation, parent/child lineage, and visible live status. Support queue, follow-up/wake, wait, interrupt/cancel, resume, and close as distinct operations. Enforce depth/fan-out/budget in Rust, coordinate file conflicts, and require parent synthesis/review. No upstream process-local state is accepted as durable authorization or PASS evidence. |

## Contract and flow mapping

1. **Context request:** Core resolves versioned profile + selected instructions/skills/templates + bounded history/artifacts → records source revisions/trust/digests in `ContextSelectionV1` → compiles one request. Context edits after dispatch apply to the next request, not the active request.
2. **Delegation:** coordinator validates task/result contract and disjoint or serialized write scope → Rust reserves bounded capacity → Core creates or resumes linked child Session → durable lineage and idempotent accepted input are recorded → child activity is projected without copying its whole transcript into parent context → parent inspects and synthesizes bounded result/evidence refs.
3. **Effectful tool composition:** model/script proposes named tools → registry resolves already exposed capabilities → Rust validates authenticated Attempt, lease, scope, budget, batch limits, and consent before dispatch → ExecutionHost returns durable receipt/evidence → nested usage is attached to the parent call. Any ambiguity remains `UNKNOWN` until reconciliation.
4. **Reconnect/replay:** client loads canonical Session and managed snapshots → subscribes to source-generation-fenced live events → gaps, overflow, or failed consumer trigger a canonical resnapshot. No missed event is treated as state.
5. **Analytics:** provider-reported token/cache values and provenance-bound estimated costs flow to the existing analytics projection → compact status line plus bounded detail view; analytics never drives authorization or automatic routing.

## External source register

- Pi coding agent source and docs: <https://github.com/earendil-works/pi/tree/main/packages/coding-agent>
- Pi repository and experimental Durable framework: <https://github.com/earendil-works/pi>
- Pi CodeMode docs: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md>
- Pi Durable README: <https://github.com/earendil-works/pi/blob/main/packages/durable/README.md>
- Pi model catalog: <https://pi.dev/models>
- Models.dev catalog and API documentation: <https://models.dev/>
- Codex multi-agent source: <https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs>
- Current OpenAI multi-agent guide: <https://developers.openai.com/api/docs/guides/agents-api/multi-agent>
- Codex managed-harness overview: <https://developers.openai.com/api/docs/guides/agents-api/overview>

The public GitHub `main` links are moving references, not HorizonCode pins. The local source trees are ignored reference material, not tracked source. The Codex snapshot has no local Git identity, so its asserted §42 commit pin is unverified against current files. The OMP clone has a local Git identity but is not the official Earendil Pi repository. No code was copied.

## HorizonCode work disposition

- **Already designed:** profile-pinned context and subagents (§29–30); explicit tool exposure and CodeMode constraints (§29, §42); usage provenance and analytics (§31); direct/managed subagent contracts and flows (§37, §45); timeline/fork UI and event replay fencing (§31, §45).
- **Still implementation work:** finish P1 Guard/ExecutionHost before enabling nested CodeMode or effectful tools; complete P2/P8 authenticated delivery/recovery and independent verification; finish P7 stream, analytics, artifacts, and branch UX source; reconcile model catalog provenance and the final provider/model UI.
- **Explicitly deferred:** automatic prompt-cache warming; hosted session sharing; a second durable harness/session store; implicit virtual-model routing; any effectful nested tool dispatch outside Guard.
- **Evidence status:** no tests, builds, live provider calls, benchmark runs, or release checks were performed for this comparison. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## Codex source detail — local snapshot review

The local ignored Codex snapshot has explicit spawn, send-message, follow-up, wait, interrupt,
list, resume, and close operations. Its guidance asks the coordinator to give bounded independent
tasks, disjoint write scopes, avoid duplicated work/reflexive waits, and continue useful work while
children run. Spawn reserves tree/capacity/residency, creates a child, persists the lineage edge,
then admits initial input; cancellation cleanup owns the partially created child until input is
accepted. Active execution, total child count and resident memory have separate local budgets.

Its protocol distinguishes collaboration call/result events from child lifecycle activity; the TUI
bounds/deduplicates activity and has retained-agent status filters. The history store persists
thread topology, but its mailbox/runtime registry/residency are process-local and completion notices
are best-effort. HorizonCode's durable delivery/ACK/Attempt receipt and named wait are intentional
stronger contracts. The comparative research does not justify new P2 schema/runtime; it confirms
existing §§29.5/45.8 and suggests reuse of ordered admission, distinct budget accounting, bounded
activity UI, and parallel-work guidance. Codex local references: `repos/codex/codex-rs/core/src/tools/handlers/multi_agents_spec.rs`, `core/src/agent/control/`, `agent-graph-store/`, `protocol/src/`, and `tui/src/`.

## Local source audit and implementation consequences — 2026-10-21

This is a repository-local review only. The Pi-like checkout available here is
the ignored nested clone `repo_take/oh-my-pi` at local commit `a536558` (2026-10-16), not the Earendil `pi` repository;
it has no `packages/durable` directory. The Pi Durable RFC and coding-agent behavior
quoted in the request are therefore treated as supplied design material, while coding
agent implementation observations below are from the OMP clone. Do not report this as a
fresh review of upstream Pi. The ignored local Codex source snapshot has no independent Git
identity; its claimed upstream commit cannot be verified against these files under the
repository-only boundary. Use it as local source reference only, not as a pinned or current
upstream checkout. No remote fetch was performed.

### Pi coding-agent patterns selected

- **Context loading:** `packages/coding-agent/src/discovery/agents-md.ts`,
  `extensibility/skills.ts`, `session/session-context.ts`, and prompt-template
  loaders demonstrate project instruction discovery and progressive skill/template
  disclosure. Adopt the loading boundary and selection UX; HorizonCode must instead pin
  trusted source identity, revision, trust, inclusion reason, and digest in one
  request-bound ContextSelection before dispatch. Context edits affect a later request.
- **Conversation history:** session persistence/entry/manager modules and fork/tree
  commands show append-oriented history with branch navigation, compaction markers,
  and continuation from a selected branch. Adopt branch lineage, replayable history,
  and compaction summaries as derived context. Keep the canonical writer in Core and
  preserve the source transcript; do not import a second Pi store.
- **Steering:** `packages/agent/src/live-steering.ts`, the session queued-message
  machinery, and RPC input/subagent adapters separate interruption/steering from
  follow-up delivery. Adopt explicit modes and visibly ordered messages. In HorizonCode,
  only the authenticated Rust/Core delivery contract can wake a child turn; a queued
  message alone cannot cause provider dispatch.
- **Tools and extensions:** extension wrappers, RPC host adapters, MCP integration, and
  dynamic tool registries are useful composition/discovery patterns. Adopt deferred
  descriptions only for already-authorized capabilities. Every invocation and nested
  call remains subject to HorizonCode Guard, Attempt scope, lease, and receipt checks;
  an extension hook or host callback is not an authority boundary.
- **Compaction and cache:** compaction/replay policy and the cache warmer show useful
  long-context recovery and provider-specific prefix reuse. Adopt bounded compaction at
  request boundaries with original history retained. Keep speculative/cache warming off
  by default because it creates provider traffic outside requested work.
- **Usage and activity:** usage/context commands and the TUI activity/subagent HUD provide
  compact token, cost, context, elapsed-time, and child-state affordances. Adopt the
  compact status plus bounded detail view while keeping `reported`, `measured`,
  `estimated`, and `unknown` distinct and preserving parent-call attribution.

### Existing HorizonCode CodeMode boundary

The first-party `packages/codemode` already implements the useful CodeMode mechanics:
an explicit schema-described tool tree, a confined interpreter, structured outputs,
bounded output/catalog discovery, OpenAPI-backed tool construction, and deterministic
tool search when the catalog is too large. The important local design constraint is in
its package docs: CodeMode confines program syntax to supplied tools but does not own
host authorization, persistence, durable replay, per-child invocation identities, or
effect receipts. In the Core V2 adapter, one outer `execute` call owns the nested calls;
it does not independently run registry hooks or model-output bounds for each nested
call, so intermediate structured data remains available to the script.

For HorizonCode, retain this interpreter and its progressive catalog behavior. Do not
add MCP-specific authority or another runtime: MCP tools should be ordinary explicit
registered capabilities. Before enabling effectful nested calls, P1 must make each
leaf effect re-enter the same authenticated Rust Guard/ExecutionHost with the enclosing
Attempt, capability scope, lease, limits, and receipt/UNKNOWN rules. If the current
adapter cannot preserve atomic batch admission and one-use effect receipts for those
nested calls, keep the effectful CodeMode entry unavailable and permit only independently
approved read-only tools. Do not treat `onToolCallStart`/`onToolCallEnd`, Core registry
wrappers, or a sandboxed interpreter as authorization or durable completion evidence.

### Codex parallel-execution patterns selected

- `core/src/tools/handlers/multi_agents_spec.rs` defines a deliberate operator surface:
  spawn, message, follow-up/wake, wait, interrupt, list, resume, and close. Keep those
  lifecycle operations distinct in HorizonCode's user and tool contracts.
- `core/src/tools/handlers/multi_agents/spawn.rs` validates depth and role/model inputs,
  prepares child config, preserves parent/root turn lineage, and passes an explicit
  initial input to the central agent-control service. HorizonCode should preserve the
  ordering discipline: validate scope/budget and reserve capacity, create/persist child
  lineage, then accept the initial delivery; a failed delivery must leave a recoverable
  child state rather than an orphaned live child.
- `core/src/agent/control/{spawn,spawn_guard,budget,residency,mailbox,delivery,interrupt,resume,completion}.rs`
  separates spawn admission, active/resident budgets, queue-only mailbox delivery,
  wake-triggered turns, interrupt, resume, and completion. Adapt the distinctions and
  budget dimensions to Rust-managed durable state. Do not copy the process-local mailbox
  as durable authorization: HorizonCode needs persisted delivery IDs, authenticated
  lane-specific authority, ACKs, owner epochs, and UNKNOWN reconciliation.
- `agent-graph-store` records thread spawn topology; protocol and TUI surfaces project
  collaboration lifecycle separately from ordinary conversation transcript. Adopt a
  bounded task tree and distinct activity events. Keep canonical state in Rust managed
  records/Core Sessions, not a second graph authority; child reasoning stays redacted.
- Codex guidance that parallel tasks be independent, bounded, non-overlapping, and
  synthesized by the parent is a coordinator-quality rule, not a security proof. HorizonCode
  adds explicit write-scope reservations/conflict detection and independent review before
  results are accepted.

### Immediate HorizonCode source gap

The comparative design only pays off if the exact context compiled for the model is what
its authority digest pins. Current source review found managed admission constructing an
empty selection before the Task prompt/profile/tool/system content is compiled. P1 owns
strict Rust/schema validation and the returned digest; P7 owns compiling the actual bounded
managed request before admission and passing the same immutable request to the provider.
Neither an empty selection nor a separately compiled Core Session history is evidence for
the managed prompt. Until the real Task, accepted Spec, profile, tools, instructions, skills,
templates, history, and artifacts have authentic owner revisions/digests and are included
in the admitted selection, managed prompt dispatch must remain fail-closed. No runtime
gate changes based on competitor implementations.

### Explicit non-adoptions

Do not import Pi Durable's experimental TypeScript scheduler/storage, generic host execution
environment, hooks-as-effect-authority, or runtime lifecycle. Do not copy Codex's
process-local residency/mailbox state as restart-safe authority. Do not add a second model
catalog, session writer, effect executor, or conversation scheduler. Keep hosted sharing,
automatic cache warming, implicit model routing, and nested callbacks that bypass Guard
deferred or disabled.

### Pi Durable contract-level mapping from the user-supplied RFC

This maps the supplied Pi Durable description against HorizonCode's HLD/LLD, owner
boundaries, and event flows. It is design analysis; it does not claim that the local OMP
fork contains Pi Durable or that every upstream Pi source file was reviewed.

| Pi Durable contract or flow | HorizonCode owner and contract | Event/UI mapping | V1 decision |
|---|---|---|---|
| Durable storage, restartable long runs, task checkpoint before effects | Core owns direct Session history; Rust ManagedControl/WorkerDurable owns managed Task, Attempt, effects, receipts and recovery (§§04, 12, 29, 37). | OwnerLog replay and source-generation-fenced Core streams; canonical snapshot/resnapshot and durable UNKNOWN (§§04.11, 37, 45). | Reuse invariants only. Do not import Pi Durable's store, task engine, or execution environment. |
| Per-conversation agent, instructions, selected tools and execution directory | Core Config's immutable AgentProfileV2 plus authenticated Location/worktree and capability ceilings (§§29.2, 29.20, 37). | Profile revision/digest and effective scope are pinned in lane-tagged `SubagentDeliveryV1`; TUI renders owner projections. | Use versioned profile and trusted owner facts; reject request-supplied identity, cwd, or authority. |
| Progressive project instructions/skills/templates and dynamic context | Core ContextService resolves trusted bounded sources; `ContextSelectionV1` records trust/revision/digest and exact provider input (§§29.21, 30.24, 37.22). | Managed `managed_context_advanced`; each provider request has its own ordered ContextSelection. | Adopt progressive disclosure with request-bound pins. No ambient hook injection. |
| System/tool changes mid-conversation while preserving prompt-cache behavior | Core Session compiler owns prompt and tools; changes freeze at request boundaries; profile/tool exposure cannot widen Guard authority (§§29.21, 30.24). | ContextSelection source revisions and Core Session cursor identify each request basis. | Adapt transcript-aware changes; only future requests see changed configuration. Cache warming remains off. |
| Safe replay classification, exact request IDs, cancellation and UNKNOWN after crash | Core Session and Rust HostKernel/EffectHost own idempotency, leases, process/effect receipts, cancellation and reconciliation (§§04, 14.24, 37.22). | `managed_context_advanced`; `managed_provider_request_prepared`, `managed_provider_request_dispatching`, then `settled` or `unknown`; unresolved dispatch is never replayed (§§04.14, 45.19). | Reuse state-machine invariants. Provider requests after DISPATCHING recover as UNKNOWN, never automatic retry. |
| Parallel conversations, forks, ownership tree and child tasks | Core Session owns direct branches/transcripts; Rust owns managed Task/Attempt DAG and worker reservations (§§29.2, 29.20, 37.22). | Distinct direct/managed lanes in delivery envelope; branch and child activity project from canonical owners (§§12.11, 45.12). | Use existing owners. A direct child needs no Goal; a managed child requires accepted Spec and Attempt authority. |
| Subagent as owned conversation, child details under tool call, parent waits | Core TaskTool and `SubagentDeliveryV1`; Rust admission/consume/quiescence and P8 lease for managed children (§§12.11, 29.20, 37.22). | Bounded child status/activity projection; wait, cancel, resume and close are separate operations (§§12.11, 45.12). | Adapt lifecycle and ownership; child message/process exit is not managed completion evidence. |
| Queue-only message vs steering/follow-up wake | Authenticated `agents.message` chooses `queued` or `follow_up`; HostKernel issues one-use fresh-turn authorization only for an actual wake (§§12.11, 29.5, 37.22). | Durable inbox receipt/ACK and explicit delivery mode; queued delivery does not start a turn (§§04, 12.11, 45.12). | Preserve explicit mode and ordering; do not infer dispatch from a queued message. |
| Extension tools/wrappers/hooks and per-conversation tool removal | Core registry is discovery/composition only; every effect re-enters Rust Guard/ExecutionHost and mediated ToolBatch (§§14, 29, 33). | Tool/effect lifecycle links authenticated Attempt, intent, lease and receipt, not hook callbacks. | Adapt modularity/deferred descriptions; effectful hooks/callbacks remain unavailable without Guard mediation. |
| Compaction as durable task, older history retained, manual compaction/handoff | Core Session compaction and branch history remain canonical; summaries are derived artifacts with source lineage (§§30, 31, 45). | Compaction/summary markers are Session projections; exact source history stays recoverable. | Adopt bounded request-bound compaction and handoff summaries; never replace canonical history/evidence. |
| Durable application documents and fork-as-of semantics | Core Session metadata/SQLite migrations own direct Session data; Rust ManagedControl owns managed facts; ArtifactStore owns artifacts (§§12, 18, 30, 37). | Mutations use the owning event/transaction and revisions; UI subscribes to owner snapshots. | Do not introduce generic Pi document storage or second fork-state authority. Add only domain state required by V1. |
| Join late, snapshot then deltas, socket commit stream | Core event multiplexer and Rust owner projection expose snapshot plus fenced deltas (§§04.11, 31, 45). | Sequence/source-generation fencing, overflow gap and canonical resnapshot. | Adopt snapshot-on-attach and bounded replay; no second event bus. |
| Token/cost/elapsed footer and child-task visibility | Usage provenance and bounded analytics live in Core Session message projections/TUI (§31.21); managed receipts remain Rust authority. | Compact status plus bounded Debug detail; reported/measured/estimated/unknown remain distinct. | Adopt UI and attribution, not a duplicate store or implicit price fallback. |
| Export/share, model catalog, cache warming and virtual models | Core owns local Session export and existing models.dev metadata; provider selection/config owns route/auth truth (§§16, 30, 31, 42). | Export is local/redacted/user-triggered; catalog facts retain provenance. | Local export only where already in V1 scope; hosted share deferred. No new catalog, hidden route, implicit virtual-model routing, or automatic cache traffic. |

Cross-references: `arch_V1/29-AGENTS-SKILLS-HOOKS-MCP.md` §29.21,
`arch_V1/30-CONTEXT-INDEXING-LOCAL-MODELS.md` §30.24,
`arch_V1/31-UI-PERFORMANCE-ARTIFACTS-ANALYTICS.md` §31.21,
`arch_V1/37-RUNTIME-SERVICE-LLD.md` §37.22,
`arch_V1/04-STATE-EVENTS.md` §04.14 and
`arch_V1/45-V1-EVENT-FLOWS-ATLAS.md` §45.19. This comparison creates no new owner,
event name, scheduler, or runtime.

### Evaluation harness readiness and additions

The current `scripts/eval/eval_harness.py` is deliberately fake-provider-only. It validates
frozen paired-arm manifests, task partitions, randomized paired order, result journaling and
resume, scorer outcomes, failure classifications, per-arm token/cost/time/tool/retry accounting,
and repository-local artifact integrity. Its reports say `officialScoreEligible: false`,
`hup001Complete: false`, and OS resource usage `UNKNOWN`. It does not invoke HorizonCode,
OpenCode, Codex, a model, a benchmark container, or a real independent verifier. The companion
fixtures in `scripts/eval/test_eval_harness.py` have not been run.

The V1 evaluation docs already add the missing experiment design: equal frozen model/provider
route, revision, repository image, prompt, oracle, permissions, tool allowlist, sampling and
budgets across paired arms; a declared minimal single-turn baseline versus full HorizonCode;
optional predeclared ablations; per-task paired outcomes; repository-grouped uncertainty; and
separate development, smoke, and held-out manifests. The report must keep `passed` and
`resolved` distinct where a benchmark exposes both, attribute failures by evidence, and report
cost/resource/failure rates alongside success. Never treat a fake self-check or smoke subset as
an official benchmark result.

When the source implementation hold is lifted, the repository's documented order is:
(1) fake-only HUP-005 self-check; (2) one explicitly selected free OpenCode provider response
and bounded coding task, recording 429/error honestly with no paid/provider fallback; (3) pinned
FeatureBench V1.1 fast split and small development-only SWE-bench Lite / Terminal-Bench 2.1
samples to validate the adapters; (4) frozen paired baseline/full-harness and ablation runs on
held-out tasks, with full SWE-bench Verified only if compute permits. Keep dataset version,
split digest, scoring field/evaluator, harness commit/configuration and image pinned. The numbers
quoted in the request are motivation only: the V1 catalog already records different source
figures and explicitly warns that benchmark release, harness, hardware, score field and model
configuration make headline percentages non-comparable. Do not promise a target uplift before
HorizonCode's paired experiment supports it.

The managed prompt audit also found the TS admission adapter rejects a ContextSelection whose
sessionID equals the child Session, while HostKernel requires that exact child Session and
separately checks the parent Session. P2 owns making the TS boundary match HostKernel and
persisting request sequence/ID/digest in Core/OpenCode managed scope projections; P7 owns the
actual provider boundary, and P1 owns the Rust check/receipt. The model-input digest must name
the child Session that owns the prompt; the root Session is lineage only.

### Managed pre-admission ordering correction (2026-10-21)

The existing one-step contract was circular: P8's exact reservation pins included the
ContextSelection digest, while Core needed the reserved child worktree to compile that
ContextSelection. The decided flow is two-stage and remains no-dispatch until Attempt admission:

1. `managed.pre_admission_target.reserve` authenticates the selected candidate and reserves its
   child target against all already-known Task/Spec/profile/permission/capability/parent/resource/
   workspace pins. It returns a target only from the opaque P8 reservation proof and grants no
   Attempt, claim, effect, or provider authority.
2. Core compiles the exact request without dispatch on that target. `managed.pre_admission_target.bind_context`
   validates the complete bounded ContextSelection against the same live facts and immutably binds
   its Rust-canonical digest to the same still-RESERVED lease through P8's durable
   `PreAdmissionContextBound` OwnerLog event. Exact replay returns the same receipt;
   changed context conflicts. A crash before binding is recoverable only for the same candidate or
   by safe reconciliation.
3. Attempt admission consumes the already-bound reservation and attaches the exact
   DelegationBinding. It never reserves a second target. Claim/consume and provider dispatch remain
   separately gated by P1 Guard, execution, request receipt and UNKNOWN recovery.

Ownership: P1 implements authenticated HostKernel/protocol validation; P8 owns staged reservation,
target projection, context binding and crash/reconciliation; P2/P7 preserve the exact prepared
request through admission. This resolves the LLD ordering contradiction without treating a Core
digest as authority or weakening P8's reservation identity. See `arch_V1/37-RUNTIME-SERVICE-LLD.md`
§37.22 and `arch_V1/18-OPERATIONS-RELEASE.md` §18.18. Source implementation is underway; no
verification is implied.

### Focused local source comparison (2026-10-21)

Scope: this is a targeted read of the local Pi-like coding-agent clone at
`repo_take/oh-my-pi` and the ignored Codex snapshot at `repos/codex`; it is not a complete
repository audit, a clean-tree audit of Codex, or a check of either project's latest upstream.
The user-provided Pi Durable description is treated as a separate design input. Architecture
citations below are normative HorizonCode sections; source paths are evidence for the described
reference pattern only.

| Area and observed local source | Decision for HorizonCode | Normative fit and limits |
|---|---|---|
| **Instructions and context engineering.** OMP `packages/coding-agent/src/discovery/{agents,agents-md,helpers}.ts` discovers project/user AGENTS.md, SYSTEM.md, skills, rules and prompt templates; `session/agent-session.ts` refreshes prompt metadata and can update the system-prompt view during a running session. | **Adopt progressive discovery; adapt authority and timing.** Resolve from trusted workspace/profile scopes, pin revision/trust/digest and inclusion reason in the actual request selection, and freeze changes at request boundaries. | §30.2–30.5 defines ContextLedger, compiler layers, small-model budgets and progressive tools; §29.21 requires a revisioned `ContextSelectionV1`. OMP's filesystem walk-up and live reload are UX/source-discovery examples, not sufficient trust or managed-attempt authority.
| **Sessions, branches and forks.** OMP `session/session-entries.ts` stores entry `id`/`parentId`, compaction markers, branch summaries, session init, model changes and usage records. `session/session-manager.ts` maintains the append-oriented tree, active leaf, branch navigation and fork-from-history behavior; `commands/session.ts` exposes session navigation. | **Adopt branch semantics through Core's existing Session.** Preserve ancestry and immutable fork point; branch/fork UI acts on canonical Session history. Do not port the OMP JSONL writer or create a competing transcript store. | §30.3 `/clear` retains history; §§31.18 and 45.18 specify checkpoint/rewind and timeline behavior. §17's one-writer/source ownership remains binding. Hosted export/share is not implied by local branch support.
| **Compaction and recovery.** OMP `session/turn-recovery.ts`, `session/session-context.ts` and `compress/{index,session}.ts` separate context building, bounded retry/recovery, summary generation and a restricted compressor session. `session/session-entries.ts` retains a summary, first-kept entry, token-before/after and replay boundary. | **Adapt provenance and recovery records.** Compact only eligible history at a request boundary; keep source history retrievable and bind summaries to covered cursor/digest. Reuse retries only for provably safe work. | §30.3–30.4 sets trim/prune/compact/clear semantics and protected facts; §§04.7–04.8 and 45.9 define recovery/fencing. A summary or resumed model response cannot become verification evidence.
| **Steering and child lifecycle.** OMP `session/queued-messages.ts`, `modes/rpc/rpc-subagents.ts`, `task/structured-subagent.ts`, `session/agent-session-events.ts` and `task/workpool-*` expose child work and message delivery; the supplied Pi Durable RFC makes task ownership, request IDs, foreground/background and replay rules explicit. Codex `core/src/tools/handlers/multi_agents_spec.rs` and `multi_agents_v2/{spawn,send_message,followup_task,wait,interrupt_agent,list_agents}.rs` expose separate lifecycle operations. `core/src/agent/control/{spawn,spawn_guard,budget,residency,mailbox,delivery,interrupt,resume,completion}.rs` shows admission, queue-only mail, wake, wait and cleanup boundaries. | **Adapt explicit operations and ownership; preserve Horizon's two lanes.** Use named spawn/message/follow-up/wait/interrupt/resume/list/close and explicit queued versus turn-triggering modes, plus a user-visible bounded activity tree. Bind children to AgentProfile revision/digest and effective scope. | §§29.2, 29.5, 29.13, 29.17–29.20, §37.9 and §45.8 own profile, delegation, limits and flows. Codex's mailbox/residency are process-local and its graph records topology, not Horizon's authority, receipts or durable ACK. Pi Durable's durable task engine is a design reference only. Neither model self-report nor child exit proves task completion.
| **Parallel scheduling and coordinator behavior.** Codex `multi_agents_spec.rs` describes the tool surface; `core/src/agent/control/spawn.rs` persists/updates child topology and controls startup; `agent-graph-store/src/{store,types,local}.rs` defines a storage-neutral parent/child edge; `tui/src/multi_agents.rs` renders collaboration activity. The local tool guidance emphasizes independent deliverables, bounded/disjoint work, avoiding duplicate delegation and parent synthesis. | **Adopt the coordination discipline, adapt persistence and conflict semantics.** Start independent work concurrently subject to real slot/resource limits; carry explicit write ownership, budget and lineage; inspect partial output after interruption; synthesize/review at the parent. | §§29.13, 29.17–29.18, §21.11 and §45.8 define Horizon's DAG/worker limits, ownership and conflict handling. Codex topology is useful for display/rebuild ideas, not canonical managed state. The local snapshot is not evidence that every concurrency path survives crash or has Horizon Guard semantics.
| **Events and reconnect.** OMP's entry tree/session state supports reconstructing a branch; Pi Durable's supplied RFC describes snapshot then commit deltas. Codex's protocol and `tui/src/multi_agents.rs` separate collaboration activity from transcript display, while `agent-graph-store` persists parent-child edges. | **Adopt snapshot plus deltas and separate activity projection.** Fence by owner/source generation, detect gaps, then resnapshot; bound and redact child activity. Keep canonical writes with Core Session/Rust owner logs. | §§04.1–04.14 and 45.3, 45.8, 45.16 define source streams, event classes, replay and projection. Do not use transient UI activity, analytics or a graph-store edge as effect/task evidence.
| **Token/cost/usage UI.** OMP `session/session-entries.ts` stores provider/model usage and `session/session-stats.ts`, `commands/{usage,stats}.ts`, and `slash-commands/helpers/{usage-report,stats-dashboard}.ts` compute/display totals, cache reads/writes and context utilization. Codex `tui/src/token_usage.rs` and `tui/src/chatwidget.rs` distinguish last-turn and accumulated token usage and present cached/input/output/reasoning counts. The reviewed Codex paths evidence token/context UI, not a cost-calculation pipeline. | **Adopt compact usage plus drill-down.** Show selected route/model, context utilization, input/output/cache tokens, elapsed time, child usage and cost with provenance/freshness; unknown remains unknown. Aggregate child charges to parent call while preserving child attribution. | §§30.2, 31.11, 31.21 and 45.16 define metrics and presentation. Cost estimation must use the selected model's catalog price and captured model revision; reference UI formatting does not prove price correctness or provider-reported values.
| **Tool discovery, deferral, CodeMode.** Codex `state/migrations/0019_thread_dynamic_tools_defer_loading.sql` adds a persisted `defer_loading` bit; `code-mode-protocol/src/description.rs` documents deferred nested-tool search and bounded schema rendering; `code-mode-runtime/src/service.rs` runs isolated V8 cells with yield/cancel mechanics; `app-server/src/dynamic_tools.rs` returns dynamic tool responses to the thread. OMP tool/capability registries and the existing Horizon `packages/codemode` provide parallel discovery/composition patterns. | **Adopt deferred descriptions; retain Horizon CodeMode; gate nested effects.** A deferred descriptor can save prompt tokens and be searched later, but expansion must be from the same canonical registry generation and already-authorized scope. CodeMode scripts compose bounded declared tools only; each effectful leaf must enter the same Rust Guard, batch, lease and receipt path. | §30.5 and §33.21 require progressive tool exposure; §§14.1–14.4, 29.21 and 45.6 require universal Guard mediation. Codex's V8 isolation/yield is a runtime design reference, not proof of OS confinement, authorization, durable idempotency or receipts. Do not add a second interpreter/runtime or grant via search results.
| **Model catalog and non-chat/virtual models.** OMP has its own `pi-catalog` model metadata; Codex's model catalog and CodeMode protocol support structured tools/content and code execution. User-supplied pi.dev/models and models.dev descriptions suggest provider-agnostic modality/price metadata. | **Keep models.dev as the existing metadata source; adapt virtual tasks only as explicit selected calls.** Image, embedding, judge or classifier work must be an explicit capability/profile-bound request with its own selected route, cost/consent and evidence class. | §§16.5–16.8, 30.6, 29.21, 31.11 and §42's catalog provenance retain one provider/model authority. No hidden fallback, automatic model switch, or parallel catalog. The local references do not establish that a local model supports every modality merely because the catalog lists it.
| **Cache warming.** OMP `session/cache-warmer.ts` computes provider-specific TTL/tier and savings estimates, schedules background refresh calls, and stops on cache miss/context changes; the compressor explicitly opts out in `compress/session.ts`. | **Defer automatic warming.** It is extra provider traffic and can incur cost while no user request is being served. A future opt-in would need route-specific TTL evidence, cancellation, displayed cost/savings and separate usage accounting. | §§16.8, 30.1, 31.11 and 42.12 require explicit cost/privacy treatment. A provider-specific implementation in a local fork does not justify background calls in HorizonCode V1.
| **Tree sharing and multiplayer.** OMP supports local session/export workflows; Pi Durable's supplied text describes multiple clients attaching to committed view state and steering/follow-up. | **Keep local history navigation in scope; defer hosted sharing.** If local export exists, make it explicitly user-triggered and redacted; external upload is a separate disclosure/consent action. | §§04.11, 16.8, 31.21 and 45.16 cover replay/UI. The initial review relied on the supplied RFC and local snapshots; the later live source check below confirms the view-state/steering pattern. This still does not authorize Horizon external services.

#### Product-level takeaways

1. **The baseline should be parity in workflows, stronger authority in execution.** HorizonCode should offer the familiar agent lifecycle (spawn, communicate, follow up, wait, interrupt, inspect, resume, close), searchable/deferred tools, skills and prompt resources, branches, compaction, and token/cost/activity UI. Their existence is usability parity; they must all route through the established Core/Rust owners.
2. **“CodeMode” is a useful orchestration shape, not a substitute for effects security.** Both the Codex reference and HorizonCode's interpreter make it convenient to compose calls. Only Horizon's Guard/Attempt/lease/receipt contract decides whether a nested effect can run. Script isolation bounds language/runtime capabilities; it does not grant or prove external-effect confinement.
3. **Use the stronger durability contract where references differ.** Pi Durable's supplied design offers task ownership, checkpointing, replay classification, snapshots, and exact submission IDs; the local Codex control path offers separate lifecycle operations and topology. Combine those invariants with Rust's durable owner log, one-use authority and UNKNOWN reconciliation. Keep Core as the direct transcript owner.
4. **Context and analytics should be inspectable product surfaces.** The user should be able to see what context/tool set was sent, where it came from, token estimate quality, selected provider/model, actual reported usage, estimated cost inputs, and live child status. A compiler's digest without the complete source/revision manifest is insufficient.
5. **Treat upstream behavior as a moving reference.** The initial review used the local Codex/OpenCode snapshots and the Pi Durable text supplied by the user. A later live read-only source review is recorded below; it does not establish license-level suitability for copying implementation code.

#### Open design conflicts or follow-up

- HorizonCode §29.21 calls for future-request context revisions; Pi's dynamic context examples rebuild sections before requests. Confirm in P7 acceptance that a mid-turn edit never mutates the already-admitted provider payload and that the next request receives the newly pinned selection.

## Live source check — 2026-10-21

The user clarified that the local-filesystem boundary does not prohibit web research. I therefore checked the current Pi coding-agent SDK docs and Pi Durable README, plus current OpenAI Codex source/docs surfaced by GitHub search. This was read-only research; no external source repository was cloned.

### What the sources support

- **Pi coding-agent (SDK):** `AgentSession` owns one conversation, its model/tools, queued messages, compaction and extension runtime. `SessionManager` owns persisted entry trees and active-leaf selection; forks switch the active branch without deleting abandoned branches. ResourceLoader supplies extensions, skills, prompts, themes and context files; SDK callers opt into codemode/tool-search/MCP extensions. This supports HorizonCode's direct Core session ownership, context-resource discovery, local branch navigation, and deferred tool discovery patterns. It does not justify transplanting Pi's session runtime into Rust-managed work.
- **Pi Durable:** the implementation makes each model request, tool call, and compaction a task with checkpoints; replay safety is explicit; task/conversation ownership controls abort propagation; request IDs deduplicate resubmission; committed view state supports reconnecting clients; extensions resolve at task-phase boundaries. Adopt these invariants where they strengthen Rust's existing OwnerLog/Attempt/receipt model. Keep Rust as the only managed durable authority; do not add a second durable runtime.
- **Pi Durable limitation to preserve:** its README describes extension/task flexibility, but current issues discuss incomplete parity between Durable and coding-agent extensions (dynamic loadout, compaction hooks, response continuation). Do not assume feature parity or take the experimental harness as a complete implementation template.
- **Codex parallel execution:** current source describes the explicit spawn-agent contract and parent orchestration; the parent receives structured child messages/results, while child communication and scheduling are mediated by the orchestrator. This supports HorizonCode's dedicated phase ownership, exclusive file scopes, explicit dependency/handoff state, and parent integration. The local AGENTS policy remains more prescriptive because this project requires whole-phase accountability and Rust Guard invariants. An open Codex issue proposing shared message-bus/workspace semantics is a proposal, not shipped behavior; do not treat it as an established capability.
- **CodeMode/deferred tools:** Pi's current SDK docs show codemode and tool-search as extensions, inactive until enabled or exposed by MCP. Keep HorizonCode CodeMode and lazy discovery, but every effectful leaf still passes Rust Guard and existing leases/receipts. Deferred descriptions must resolve against the same pinned registry generation and authorized scope.
- **Model metadata:** keep the existing models.dev integration as catalog input rather than adding a competing model registry. Treat metadata as versioned/staleable facts, not proof of route availability, capability, price charged, or provider consent. Surface source/revision and distinguish estimates from provider-reported usage/cost.
- **Not adopting:** automatic cache warming (unrequested background provider cost), silent provider/model switching, hosted session sharing/export, a parallel TS durable runtime, or codemode as a Guard bypass. Multi-agent sharing remains parent-mediated until the repo's authenticated delegation and write-scope contracts say otherwise.

### Source links and limits

- Pi coding-agent SDK: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
- Pi Durable README: https://github.com/earendil-works/pi/blob/main/packages/durable/README.md
- Pi Durable extension-parity issue: https://github.com/earendil-works/pi/issues/10386
- Codex multi-agent specification source: https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs
- Codex multi-agent prompt source: https://github.com/openai/codex/blob/main/codex-rs/prompts/src/model_messages/multi_agent.rs
- Codex shared-workspace proposal (not evidence of shipped behavior): https://github.com/openai/codex/issues/21027

These are a point-in-time design comparison, not a complete line-by-line audit of every upstream file or a license review. The HorizonCode decisions above are constrained by arch_V1 authority and need implementation/acceptance evidence before any status promotion.
- Codex's local multi-agent tool versions differ in names and API shape (`send_message` vs legacy `send_input`, `followup_task` vs trigger flags); HorizonCode should retain its decided `agents.message` with explicit queued/follow-up mode and lane discriminator, rather than copying either transient API verbatim.
- Codex CodeMode's process/host boundary and its in-process runtime have multiple selectable deployment modes. HorizonCode should document which implementation is source inspiration versus the sole product supervisor; do not infer that language-runtime isolation meets Horizon OS confinement acceptance.
- models.dev metadata freshness/offline snapshot policy and cost-price provenance remain owned by P6. This comparison supports the existing single-catalog decision but does not settle refresh cadence, stale labeling or missing-price treatment beyond existing architecture rules.
- Local forks may contain behavior absent from canonical upstream Pi. Any source-code import still requires exact provenance and license review; this live source comparison is not that review.
