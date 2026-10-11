# 27 — Implementation-readiness audit and authoritative handoff crosswalk

**Audit date:** 2026-10-10 · **Repository:** `/home/sarvesh/business_Dev/agentx` · **Basis:** local `arch_V1` files and source/test paths, not assumptions about upstream releases.

## 27.1 What was audited — and what "complete" means

All **28** existing `arch_V1/*.md` files (01–26, `GLOSSARY.md`, `README.md`) were scanned end-to-end by a line-reading audit. The corpus contained **9,087 lines** at the start of this handoff pass; the new 27th numbered chapter increases that total. Headings, local references, code fences, exact declared ownership decisions, version markers, and implementation evidence were cross-referenced. High-risk contradictions below were inspected against the actual repository. This is an architecture **coverage and consistency audit**, not a proof that all 9,087 lines are semantically correct or that all code has been implemented.

The correct distinction is `DESIGNED → CODE_PRESENT → WIRED → TESTED → VERIFIED_END_TO_END → RELEASE_ACCEPTED`. Do not mark one state as another.

## 27.2 Requirements coverage crosswalk

| Area | Governing docs | Design coverage found | Implementation/release status |
|---|---|---|---|
| Universal builder for non-devs and developers | 01, 07, 16, 22, 26 | Create/Develop/Delegate/Operate, visual+code handoff, source ownership, novice status/preview | User journeys are **not** live end-to-end |
| OpenCode reuse, pin, provenance/licensing | 06, 08, 09, 17, 19, 24 | Upstream reuse matrix, package dispositions, release/update constraints | Existing source present; full provider regression/update parity pending |
| Full provider/model/session capabilities | 02, 06, 12, 15, 19, 20, 22 | provider selection, context, session, local models, harness negotiation | Provider/source present; runtime parity across model categories incomplete |
| Run/Goal/Task/Attempt/checkpoints | 02–04, 11–13, 15, 20, 25 | versioned domain, transitions, events, persistence, replay, accepting criteria | Planned; no verified managed supervisor |
| Concrete packages, classes, functions and dependency direction | 01, 02, 09, 13, 20, 24, 25 | Composition and class seams, source paths, execution ownership | Some source exists; proposed signatures require contract tests |
| Events, schema, API, IPC, process topology | 04, 11–14, 20, 25 | event types, state transitions, frame formats, OpenAPI sketch, SQL proposals | Prototype SQLite inspected, not production migration; authenticated host IPC missing |
| Effect broker, sandbox/permissions, audit | 05, 14, 17, 21 | Ask/Safe Auto/YOLO sandbox, authorizations, idempotency and denial boundaries | **Not verified end-to-end**; all bypasses must be inventoried |
| Direct editing and repository intelligence | 03, 06, 09, 15, 20, 24 | semantic navigation, LSP, file edits, tool responses, regressions | Upstream tools exist; mediated behavior not confirmed |
| Local/free/inexpensive model strategy | 06, 12, 19, 21–22 | user-pinned models, same-model retry, adapted small-model harness | Capability probes and no-paid-fallback tests pending |
| Durable context, compaction, memory | 02, 04, 11–12, 15, 22 | source-provenance/context epoch, memory update, compaction | OpenCode Session functionality present; Goal survival across compaction not verified |
| Autonomous scheduling and parallel agents | 03, 11–12, 15, 21, 23 | DAG, admission, resource isolation, attempts, merge | No verified production scheduler / concurrency |
| Worktree pool and cleanup | 14–15, 18, 21, 23, 26 | lease, fencing, warm-idle reuse, quarantine, test DB/ports cleanup | Design and expected tests only |
| Four-tier self-healing | 11, 15, 21, 23 | L1 AST/test repair, L2 breaker, L3 advisory patterns, L4 sandbox canary | Not proved; must prevent unsafe self-updates |
| UI, slash commands, agent/model pickers | 07, 16, 22, 26 | three-pane workspace, action descriptor, settings, commands/shortcuts | Proposed UX not validated against actual running code |
| Skills/MCP/extensions/agents | 05, 07, 16, 19, 22, 26 | boundaries, adapters, tool registry, safe plugin management | Repo has two relevant skills; local MCP config empty on audit |
| Preview, deploy, migrations, export, operate | 03, 14, 16, 18, 22, 26 | preview, explicit release approval, backups, postrelease, export | Not end-to-end |
| Verification, evidence, budgets, completion | 04, 10–12, 15, 18, 23, 25–26 | final revision evidence, recovery, resource/usage accounting | Only core primitives and projection tests verified |
| Performance, platform and release | 06, 09–10, 14, 18, 23 | latency budgets, isolation, Windows/Linux, release gates | Native Windows and overall release gates unverified |
| Operating instructions and handoff continuity | 10, 17, 23, 24, 27; root AGENTS/HANDOFF | bounded execution loop, subagents, evidence, cleanup, next gate | Created in this audit; compliance by future agents must be verified |

## 27.3 Contradictions and disposition — do not hide them

| Issue | Evidence location | Required resolution |
|---|---|---|
| Historical Rust-canonical conversation ownership conflicts with target OpenCode canonical Session | Old `17.3` row, `02`, `11–12`, `15` versus v2 amendments and `25` | Mark old implementation strategy **superseded**, preserve OwnerLog as managed-domain store, require Session parity cutover. No duplicated transcript authority. |
| `AGENTS.md` previously claimed current branch lacked OpenCode snapshot | Old AGENTS bootstrap text vs actual `main` checkout with `opencode/` and active root packages | Replaced root instructions with observed present state; always recheck Git. |
| Legacy P0–P9 phases and new P1.2-A/B slice labels can be mistaken for the same gate numbering | `10` plus `23–25` | Use P1.2-A/B as **implementation increments**, not a new normative phase numbering. Map every slice to historic gates. |
| Event service and Rust bridge store different states | `packages/core/src/event.ts` / `session/input.ts` vs `kernel/src/session_projection.rs` | OpenCode owns conversations and event payloads. Rust projection stores bounded hashes/cursors/correlation only. Live follower is diagnostic until supervised. |
| Source-level code present may be mistaken for release ready | `kernel/src`, `packages` vs `24`, `25` | Evidence states: local code vs wired/integrated vs tested vs accepted. Never infer success from docs or package existence. |
| Prompt input, output cost and provider switching assumptions | `06`, `12.6`, `21–22` | Explicit user model selection, no automatic paid fallback; measured/unknown costs distinguished. |
| Three permission labels could imply actual sandbox | `05`, `14`, `21` | YOLO UI is unavailable until OS enforcement proven; deny bypass from plugins/MCP/hosted tools. |
| Generic HTTP/SQL contract drafts could be misread as production complete | `contracts-v2`, `25` | Draft only, needs migration/recovery/auth schemas, real API handlers and negative tests. |
| Parsed copied v2 chapters use inherited subsection numbers 09–13 under `19–23` | `19–23` | Treat inner `9.x–13.x` as imported source section IDs/provenance, not a competing file numbering system; do not automatically renumber function references. |
| Static source snapshot may diverge from active editable root package tree | `09`, `19`, `24` | Inspect diff; change only active owned file, preserve pinned reference and record divergences before upgrade. |
| Tool effect enforcement might cover only some generations | `packages/opencode/src/tool`, `packages/core/src`, `14` | Enumerate every actual effectful path; bypass paths deny/disable until broker mediation verified. |
| Compaction could lose managed Goal despite OpenCode Session persistence | `15`, `21` and runtime source | Pin GoalRevision/criteria outside model context; test across repeated compaction and restart. |

## 27.4 Missing **implementation proof**, not necessarily missing architecture

- A single tested real Session admission/projection/continuation fixture across OpenCode generation variants, including cancellation and compaction.
- Production Rust supervisor authenticated/authorized local peer, IPC state machine, bounded event subscription/backpressure, crash restart, and output redaction.
- Safe ToolIntent routing and OS-enforced host operations for every shell/edit/plugin/MCP/hosted-provider path; validated YOLO sandbox implementation.
- End-to-end Goal/Run scheduler: persisted DAG, attempts, independent verification, replay of uncertain effects and correct stopping.
- Resource worktree pool and merge integration under concurrency, including ports, databases, process cleanup and disk quota.
- Local and free models exercised with representative varying tool-call capabilities and transparent usage/cost behavior.
- Interactive novice builder, visual source selector, expert editor and test preview integrated with same project source and undo.
- Release/operate, backup/migration, export, peer auth on Windows, security and human usability acceptance.

These are real gaps and must remain named gates rather than being described as already solved in 01–26.

## 27.5 Durable handoff order

1. Read `AGENTS.md` and `HANDOFF.md` before modifying any code.
2. Read `17`, `24`, `25`, `10`, and this chapter; inspect exact current `git status`, then source.
3. Finish **P1.2-B**, authenticated and supervised live Session event delivery + real input admission parity. Then start mediated ToolIntent broker.
4. For each completed increment: update tests/evidence, affected docs/contracts, `CURRENT_RUN.md` and tracked `HANDOFF.md`; proceed to next unblocked gate without another user prompt.
5. Do not represent broad topic coverage as semantic perfection, or replace dependency/gate verification with a long document.

## 27.6 Audit methodology reproducibility

A line-by-line file scanner checked all Markdown contents and headings, local link targets, fenced code blocks, actual source path presence, and selected change references. A human operator or coding agent should also perform focused semantic review of each governing section before implementing that subsystem. The above coverage matrix is deliberately explicit about where the *specification* is detailed but the *runtime* is not verified.

## 27.7 P1.2-B implementation evidence update — 2026-10-10

- Actual OpenCode `SessionV2.prompt({ resume: false })` and `SessionInput.promoteSteers`
  have a disposable, file-backed cross-runtime test proving versioned `PromptAdmitted` →
  `Prompted` order, stable message identity, no prompt content in Rust receipts, and replay
  without duplicate import. Provider-turn completion, interruption and compaction parity
  remain open.
- Linux local peer authentication, first-message hello negotiation, READY gating, and one
  redacted Session page/ACK exchange run over a real Unix socket. The bounded subscription
  helper enforces 1–256 queued/in-flight events, sequence order, backpressure and ACK rules;
  the RPC test rejects cross-subscription ACKs. `supervisor_lease.rs` holds an owner-private
  process lock, advances a durable monotonic epoch, and is borrowed by the RPC session before
  READY. Its tests cover a competing acquisition, restart, unsafe state, shared-writable
  ancestors and epoch overflow.
- The Linux `session_supervisor` executable now performs source integrity/schema checks,
  full replay of one configured Session before READY, authenticated Subscribe/ACK page
  delivery, and lease release after the one-page connection ends. Process tests prove corrupt
  source/schema fails before listener creation, projection hardlinks are rejected, Subscribe
  cannot escape the configured Session, source bytes remain unchanged, and restart advances
  the epoch. Repeated live polling, typed `RESNAPSHOT_REQUIRED`/page-end framing, reconnect
  cursor persistence, host shutdown/cancel/restart, and native Windows runtime proof remain
  open. No effect broker or complete product-level P1.2-B acceptance is claimed.
- Next: keep one supervisor process alive across repeated bounded subscriptions, define a
  negotiated page-complete/resnapshot control contract, then integrate its child lifecycle
  through Core's existing Effect/process services. Once complete P1.2-B acceptance is
  proven, proceed to P1.3 universal ToolIntent mediation.

## 27.8 P1.2-B incremental evidence — repeated cursor pages

- Added typed `page_end` and `resnapshot_required` MessagePack controls, gated on negotiated
  `session.events.page-control.v1`. The page end carries the exact ACK cursor and `hasMore`;
  a resnapshot control binds the requested and latest cursor to the same owner. Codec tests
  cover round trips and reject cross-owner resnapshot cursors.
- The Linux observer now loops over cursor-bearing Subscribe requests for one fixed Session
  and subscription ID, refreshes the read-only EventV2 projection before each bounded page,
  waits for ACKs, and reports page completion. It exits cleanly on matching Unsubscribe and
  returns `resnapshot_required` then closes when requested history is missing. Eight process
  integration tests cover multiple pages, newly committed source events, restart resumption,
  ACK cursors, redaction, alias/schema/corruption/scope refusal, and simulated retained-history
  loss. This is client-driven polling and does not establish Core child ownership or native
  Windows acceptance.
- Next: implement the Core Effect/process child lifecycle around this executable, including
  cancellation, graceful stop, startup failure, crash/restart and durable reconnect-cursor
  handling. Then finish actual OpenCode turn/interruption/compaction parity before declaring
  P1.2-B accepted and beginning P1.3 universal effect mediation.

## 27.9 P1.2-B incremental evidence — OpenCode Core host connection

- `packages/core/src/session/supervisor.ts` provides an Effect-scoped Rust child and
  MessagePack host client, registered in `packages/opencode/src/effect/app-runtime.ts`.
  The client launches without a shell through existing `AppProcess`, validates the owner-only
  socket path, negotiates required Session/page-control features bound to a fresh nonce and
  process incarnation, waits for READY, and exposes bounded Subscribe/receive/contiguous ACK/
  Unsubscribe operations. Scope release closes the channel and waits for the child with bounded
  escalation. Rust authenticates the Bun host executable before accepting Hello.
- The actual compiled Rust supervisor was launched from Bun against OpenCode's actual
  file-backed Session prompt admission/promotion events. Tests receive versioned
  `PromptAdmitted` and `Prompted`, exclude prompt content, reject an out-of-order ACK, and
  prove Effect interruption releases the process lease, removes the socket, advances the epoch
  and allows replay after restart. Core typecheck and all five tests in the focused integration
  file pass. This does not yet mean OpenCode prompt/API flows automatically start or consume the
  service; the new service is available in AppLayer and its runtime path is exercised only by
  integration tests.
- Next: wire the client to the real OpenCode Session lifecycle without changing SessionStore
  ownership, and test automatic startup/stop/recovery. Then cover provider-turn, compaction
  and interruption parity and native Windows transport. P1.2-B is still open; P1.3 effect
  mediation remains downstream.

## 27.10 P1.2-B incremental evidence — completed-page cursor recovery

- `SessionSupervisorClient.resumeCursor` reads a private owner/sequence/event-digest checkpoint
  in the existing per-session state directory. `subscribe()` resumes from it by default and
  rejects an explicit cursor rollback once a checkpoint exists. The client writes the file
  atomically with mode `0600` only after it validates `page_end`, which the Rust observer sends
  after receiving the contiguous ACKs. It stores no Session prompt, message or provider data.
- If the host stops after ACKing an event but before `page_end`, the prior completed-page
  checkpoint remains authoritative and the interrupted page replays. A true second Rust child
  resumes from the completed cursor and receives an empty page rather than duplicate events.
  Bun integration also injects a symlinked cursor file and verifies refusal. This host-side
  control projection preserves OpenCode EventV2 as canonical; it does not implement automatic
  Session lifecycle wiring or Windows transport.
- `SessionSupervisor.node` is registered in both the CLI `AppLayer` and the active HTTP API
  root graph. `bun test --timeout 30000 ./test/server/httpapi-cors.test.ts` passes 3/3, and
  the OpenCode package typecheck passes. The composition still does not start per-Session
  children or provide a managed event consumer.
- Next: resolve the explicit runtime binary/state configuration and the actual SessionV2
  lifecycle owner/managed-control-plane consumer seam, wire startup and cancellation there,
  then cover turn, compaction and interruption parity before P1.3.

## 27.11 P1.2-B incremental evidence — recorded provider-turn parity

- `packages/core/test/session-runner-recorded.test.ts` now runs one real Core `SessionV2`
  prompt and `SessionExecution.resume` against the pinned recorded HTTP cassette. It exports
  the exact six OpenCode EventV2 rows into a disposable contract-shaped SQLite source, invokes
  Rust projection twice, and asserts ordered versioned `PromptAdmitted`, `Prompted`, step/text
  start/end and assistant settlement receipts, message ID correlation, redaction and replay
  idempotency. Result: 1 test / 15 assertions passed, no live provider request.
- This covers one successful provider turn only. It does not cover actual compaction, turn
  interruption/crash recovery or automatic supervisor ownership. Next remains explicit runtime
  binary/state configuration and the actual SessionV2 to managed-control-plane consumer seam,
  then lifecycle integration, compaction/interruption parity and native Windows acceptance.

## 27.12 P1.2-B incremental evidence — compaction and interruption parity

- `packages/core/test/session-runner.test.ts` copies exact committed EventV2 rows from Core's
  automatic completed-summary compaction and blocked-provider interruption into disposable
  contract-shaped sources and runs the Rust projection. The compaction case verifies ordered
  Started/Ended pairs, message IDs and omission of summary/recent-turn text. The interruption
  case requires exact source/projection event ordering, verifies prompt redaction and confirms
  no StepStarted receipt is synthesized when cancellation precedes the durable event.
- 2026-10-10 verification: focused compaction test **1 pass / 22 assertions**; focused
  interruption test **1 pass / 8 assertions**; `bun run typecheck` from `packages/core`
  passed. These tests establish projection parity for persisted histories, not process
  recovery during an active provider request.
- The live route trace shows the OpenCode HTTP root composes the V2 `/server` Session API
  (`packages/server/src/handlers/session.ts`) backed by `SessionV2.node` and
  `SessionExecutionLocal.node`, as well as the compatibility Instance Session API backed by
  `SessionPrompt`. `SessionSupervisor.node` is available in the root graph, but neither Session
  API currently consumes its events as managed control-plane facts. Keep automatic lifecycle
  startup gated on an actual consumer, explicit validated binary/state configuration, and effect
  route coverage.
- Next: identify that consumer and route convergence seam from chapters 17, 20, 23 and 25;
  implement owned per-Session start/stop/restart/resume there. P1.2-B remains open for move
  parity, active-turn crash recovery and native Windows acceptance.

## 27.13 P1.3 prerequisite increment — whole-response tool dispatch barrier

- Core runner source: `packages/core/src/session/runner/llm.ts` buffers local calls through
  provider terminal and step settlement, then schema-preflights the entire batch using the
  same `ToolRegistry.Materialization`. No local calls execute when a provider stream fails,
  is interrupted, ends without finish/step settlement, or contains any schema-invalid local
  call. The valid five-call case still proves concurrent execution after full admission.
- `packages/core/src/tool/tool.ts` and `tool/registry.ts` add input-schema preflight only;
  they add no persisted schema, canonical ToolBatch, Rust authorization, or execution API.
- 2026-10-10: Core runner suite **91 tests / 296 assertions** passed; Core typecheck passed;
  recorded provider turn test **1 / 15 assertions** passed.
- This closes one Core streaming dispatch hazard. Rust ThreadService-owned ToolBatch state,
  Guard/resource/budget authorization, ordered result acknowledgements, Rust execution,
  full legacy/MCP/plugin/hosted path coverage, and production route convergence remain open.


## 27.7 2026-10-11 competitive-gap audit update

Sections §§28–34 are now part of the V1 architecture package. They close specification gaps
found by comparing the active design against Codex, OpenCode, Cline, Claude Code public
patterns and Grok Build. A follow-up pass also reviewed current OpenHands, mini-SWE-agent and
Open Interpreter architecture/runtime patterns; §35 records exactly which requests each source
influenced and corrects the first-pass coverage imbalance.

| Added area | Design status | Implementation truth at audit time |
|---|---|---|
| rich AgentProfileV2/specialists/subagents | NORMATIVE (§29) | existing profile/subagent code must be mapped; no full V2 acceptance claim |
| SkillManifestV2/hooks/MCP/custom actions | NORMATIVE (§29) | upstream pieces exist; unified Horizon enforcement not accepted |
| ContextLedger + trim/prune/compact/clear | NORMATIVE (§30) | not verified end-to-end |
| small/local-model prompt/tool profile | NORMATIVE (§30) | provider substrate exists; tiny-context acceptance not yet run |
| independent HarnessProfileV1 (`native-rich`/`native-minimal`/`bash-only`/compatibility) | NORMATIVE (§29/§20/§33) | design/schema added; runtime registry/codec projections and model fixtures not accepted |
| Ollama/LM Studio/LiteLLM/OpenAI-compatible UX | NORMATIVE (§30) | must measure exact provider compatibility |
| persistent symbol/BM25 index + drift-safe IDs | NORMATIVE (§30) | implementation status requires source audit/spike |
| UI stream/virtualization/performance budgets | NORMATIVE (§31) | retained UI exists; new budgets unmeasured |
| CodeMirror 6 preferred embedded editor | NORMATIVE TARGET (§31) | integration not claimed |
| artifacts + safe Mermaid | NORMATIVE (§31) | renderer/runtime implementation not claimed |
| Mission Control/live operational feed | NORMATIVE (§31) | not accepted |
| deep analytics/dashboard | NORMATIVE V1 (§31) | underlying usage/events partial; dashboard/accuracy not accepted |
| durable automations | NORMATIVE (§31) | not accepted |
| browser/DOM normalized built-in capability | NORMATIVE (§31/§33) | backend/adapters must be measured |
| real-work task catalog | NORMATIVE (§32) | fixtures/run harness still to implement |
| built-in agent/tool/skill/job catalog | NORMATIVE (§33) | catalog is target, not current tool-list proof |
| self-improvement | POST-V1 EXPERIMENTAL | V1 may collect analytics/advisory memory only |

### Critical ownership resolution

The previous “Rust canonical Thread transcript” direction is **not** an implementation
prerequisite anymore. A-V2-11/§34 CR-01 resolves the V1 owner split:

- OpenCode: canonical conversation Session/Input/Message/Part/provider continuation.
- Rust: Horizon managed control plane, effects, permissions, leases, recovery, evidence and
  bounded OpenCode correlation.

Historical P2 transcript-cutover docs are explicitly marked superseded. Any new code that
starts duplicating message bodies into a competing Rust transcript requires a new explicit ADR
and must not be justified by the historical plan.

### New implementation priority does not replace current handoff

The currently active P1.2/P1.3 supervisor/ToolBatch/effect work remains the immediate
dependency. The new §§29–33 capability work should start when its prerequisite seams are stable
according to §10, not as an excuse to interrupt safety/control-plane convergence.

## 27.8 Second-pass implementation readiness findings

The deeper competitor/source pass did not reveal a missing top-level product plane, but it found
several implementation contracts that must be added to V1 readiness:

| Area | Current source truth | V1 readiness requirement |
|---|---|---|
| RepoIntel/index | local `indexd` README says bounded in-memory lexical PARTIAL only | persistent symbol/reference generations, watcher/supervisor, LanguageServiceBroker, LSP coexistence and large-repo tests |
| language services | OpenCode/LSP pieces exist but unified Horizon ownership not accepted | reuse compatible editor Pyright/rust-analyzer/etc.; never duplicate/kill editor server; source/generation metadata |
| read-only Plan | tool visibility alone is not an execution boundary | Guard/ExecutionHost denies shell/script/LSP/MCP mutations |
| tiny/local structured calls | provider substrate exists | malformed/truncated calls fail closed; compatibility streaming fixtures; no guessed args |
| harness/model separation | profile previously named `harness` but lacked a complete independent contract | implement `HarnessRegistry`; harness changes prompt/tool/message/response shaping only, never selected endpoint/provider/model; bash-only/minimal acceptance required |
| local cold start | local endpoint support exists | health/connect vs response-start/model-load/TTFT timing and cancellation |
| Plan→Build | Plan/Build profiles designed | structured `PlanHandoffV1` with DAG/scope/criteria and explicit revision/deviation |
| terminal output | bounded output/artifacts designed | range + search retrieval without rehydrating entire log |
| checkpoints | recovery contracts exist | later commit/branch/dirty/untracked lineage protection |
| managed retry | retry/no-progress exists | fatal/exhausted policy blocks/fails Goal/Task instead of token-burning continuation |
| UI/rendering | §31 performance design exists | frozen-prefix/incremental streaming, isolated expensive renderer, measurable hot-path benchmarks |
| runtime latency | UI budgets exist | §31.18 control-plane stage percentiles and traces |
| built-in docs skill | canonical Horizon-owned asset now CODE_PRESENT at `packages/core/src/horizon/skills/horizon-docs/SKILL.md`; `.opencode/...` is only a development shim | embedded/bundled SkillV2 registration, sealed-ID anti-shadowing, UI discovery and runtime tests still required |

### Comparison-source confidence

- Codex, OpenCode, Cline, Grok Build, OpenHands, mini-SWE-agent and Open Interpreter public source/docs are high-confidence implementation references for the specific patterns recorded in §§28/35 at the researched revisions.
- Claude Code official docs/public repo are authoritative for public behavior.
- `chauncygu/collection-claude-code-source-code` is low-confidence reconstruction/leak-derived
  research and may inspire independently designed patterns only; never treat it as a source to
  copy or as legal/behavioral truth.
- Product claims require HorizonCode's own tests regardless of competitor behavior.

These additions map to §§28–35 and the §32 second-pass cases. They **do not change the immediate
P1.2/P1.3 dependency**; they become release gates when their prerequisite services exist.

## 27.14 Final source/extraction readiness checkpoint — 2026-10-11

The source register [source provenance §42](42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md) and implementation playbook [source-to-LLD §43](43-IMPLEMENTATION-SOURCE-LLD-PLAYBOOK.md) resolve missing immutable external-code links and provide a test-first plan. The full local mechanical scan is indexed in [§44](44-FINAL-REPO-AUDIT-LEDGER.md); it does NOT establish semantic completeness of 1.5M lines. Runtime gaps remain: P1.2 supervisor lifecycle, P1.3 universal guard, cross-language schema generation, real visual/UI adapters and platform UAT. Statuses: external OMP CODE COPIED = NONE; source RESEARCH DOCUMENTED; target design APPROVED for selected UX/visual behaviors; runtime NOT IMPLEMENTED. Continue from [converged implementation plan](../docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md) before reporting completion.
