# 17. Architecture governance and decisions

Status: normative and frozen for V1 implementation. This file resolves product/ownership conflicts; it does not claim implementation.

## 17.1 Immutable V1 decisions

| ID | Decision | Consequence |
|---|---|---|
| A-V2-01 | The pinned OpenCode-derived host is the current session/tooling substrate; direct provider transport is replaceable only through A-V2-27 | No greenfield session/tool rewrite or competing conversation owner |
| A-V2-02 | Every conversation has one backend owner: HorizonCode direct Core or an explicitly selected native backend; Rust owns Horizon managed control/effects | No Rust transcript store or dual conversation owner |
| A-V2-03 | User pins provider/model/harness | No hidden quality/cost/subscription routing |
| A-V2-04 | Ask, Safe Auto, YOLO-in-sandbox are presentation modes over one Guard | No mode bypasses immutable denies |
| A-V2-05 | Worktrees are pooled, leased, capped and quarantined when dirty | No unbounded worktree creation/deletion |
| A-V2-06 | Healing is deterministic first, same-selected-model infrastructure second, advisory learning third | No self-authorizing policy mutation |
| A-V2-07 | Novice and expert UX are views over one engine | No duplicate backends by UI mode |
| A-V2-08 | Completion requires independent evidence against final integrated revision | Model self-report cannot PASS a Run |
| A-V2-09 | Existing kernel primitives are preserved and adapted | No wholesale Rust rewrite |
| A-V2-10 | OpenCode source is pinned until an explicit upgrade experiment | No automatic dev/main tracking |
| A-V2-11 | HorizonCode direct Session/Input/Message/Part continuation remains the canonical direct conversation, derived from OpenCode; native adapters own only their separate sessions | Rust stores only bounded correlation/control refs |
| A-V2-12 | Rich AgentProfile plus a small specialist set; maintenance remains jobs | Do not make every task an agent |
| A-V2-13 | ContextLedger with distinct trim/prune/compact/clear | Canonical history is not deleted to fit context |
| A-V2-14 | Symbol-first RepoIntel; embeddings optional | Opening a repo never requires embeddings |
| A-V2-15 | Local/small models are first-class | No hidden cloud fallback |
| A-V2-16 | Performance budgets are release architecture | Streaming/startup/index regressions can block release |
| A-V2-17 | Deep analytics in V1; autonomous self-improvement post-V1 | No V1 self-changing routing/policy |
| A-V2-18 | Browser/DOM and safe artifact/Mermaid are core | MCP/browser adapters share the same Guard |
| A-V2-19 | CodeMirror 6 is the preferred embedded code/diff editor | Monaco needs a measured ADR |
| A-V2-20 | Real-work task catalog is mandatory | Harness correctness and model ability measured separately |
| A-V2-21 | Contract convergence precedes new subsystem wiring | One schema/ID/error model per boundary |
| A-V2-22 | Discoverable command/provider/model-role/settings/Goal UX is adopted | One ActionDescriptor and existing auth/config owners |
| A-V2-23 | Safe SVG preview, deterministic charts, terminal Mermaid and artifact fidelity are adopted | Rendering is sandboxed and source-preserving |
| A-V2-24 | External source reuse is immutable-pin/provenance/license/test gated | Source inspection is not integration |
| A-V2-25 | Desktop/computer control, built-in web search, DAP debugging, and bounded persistent REPL are first-class coding-agent capability families | They reuse Guard/ExecutionHost, capability registry and provider/auth owners; no parallel runtime |
| A-V2-26 | Active architecture has one topic owner; research/audit/history are non-normative | Compatibility stubs may point to the owner but must not restate contracts |

## 17.2 Canonical ownership

| Aggregate/data | Canonical writer |
|---|---|
| Direct Session, Input, Message, Part, conversational tool result/continuation | HorizonCode Core (OpenCode-derived) |
| Goal, SpecVersion, Run, Task, Attempt, managed verification | Rust managed control |
| ToolBatch authorization/control metadata, EffectIntent, one-use lease, EffectReceipt | Rust Guard/EffectService/ExecutionHost |
| Provider/model/harness configuration and credentials references | Existing OpenCode/Horizon config plus SecretBroker |
| Context view/selection metadata | ContextService; direct history remains HorizonCode Core, separate native OpenCode sessions remain upstream-owned |
| Repo index/symbol generations | RepoIntel/indexd derived store |
| UI stream/render state | Derived UI projection only |
| Durable artifact bytes/metadata | Artifact store |
| Automation schedule/control | Rust automation owner |
| Plugin/skill/MCP registration | Canonical extension registry, never direct authority over effects |

## 17.3 Runtime invariants

1. Direct Session use is lightweight and does not require Goal/Task ceremony.
2. Managed work is additive: Goal -> accepted SpecVersion -> Run -> Task/Attempt -> Evidence/Verification.
3. The full provider response is collected and validated before any local effectful tool in that response executes.
4. Mutations require Guard admission and a one-use execution lease. Unknown outcomes are reconciled, not blindly retried.
5. Hosted/provider-executed effects that cannot be pre-authorized are unavailable in governed mode.
6. LSP code actions/rename, DAP attach/evaluate, browser/desktop actions, REPL host/tool callbacks, MCP/plugin calls and settings writes obey the same effect model.
7. Read-only queries still enforce caller scope, path/network policy, size/time budgets and secret redaction.
8. UI cannot create an alternate owner by writing databases directly.
9. Provider/model/harness fallback must be explicitly authorized and show cost/provenance.
10. Unknown capability/effect class fails closed.

## 17.4 Open capability/platform gates

These gate only the named capability or release claim.

| ID | Open decision/evidence | Safe interim behavior |
|---|---|---|
| DEC-V1-01 | Windows sandbox guarantees | Do not claim sandboxed effects without native acceptance |
| DEC-V1-02 | macOS isolation/release support | Mark unavailable or best-effort precisely |
| DEC-V1-03 | Linux distribution/kernel containment matrix | Capability detect and fail closed |
| DEC-V1-04 | Third-party signing/marketplace/revocation | No unreviewed executable marketplace activation |
| DEC-V1-05 | WASM runtime/import set | WASM extension unavailable |
| DEC-V1-06 | Provider secret delivery/broker transport | Authenticated provider path unavailable until verified |
| DEC-V1-07 | Managed approval posture by action class | Exact reviewed spec approval plus Guard |
| DEC-V1-08 | Verifier independence by risk tier | Distinct execution/read-only evidence; label same-model limitation |
| DEC-V1-09 | Retention/deletion/legal-hold policy | No unsupported erasure/retention claim |
| DEC-V1-11 | License/attribution/redistribution closure | Do not distribute affected bundles |
| DEC-V1-12 | Signing/update root/channels/rollback | Automatic updates unavailable |
| DEC-V1-13 | LiteSPM vs native installer ownership | One installer owner per path |
| DEC-V1-14 | Remote/cloud continuation and data residency | Local-only authority |
| DEC-V1-15 | MCP protocol/auth matrix | Pin and reject unsupported features |
| DEC-V1-16 | OS credential store/encryption | Store references only where secure storage unavailable |
| DEC-V1-17 | Durable Windows event-store synchronization | Durable managed Windows Runs unavailable |
| DEC-V1-18 | SessionLink/ToolBatchControl exact interop and failure evidence | Ownership is resolved; deny effects until P1.3 is verified |
| DEC-V1-19 | Desktop-control OS backend capability matrix | Expose only tested OS actions; no unsafe Eval escape |
| DEC-V1-20 | Web-search provider cost/auth/reliability matrix | No hidden paid fallback; unavailable provider reports reason |
| DEC-V1-21 | DAP adapter/language/OS support matrix | Read-only debugger features only where verified; Eval/attach guarded |
| DEC-V1-22 | Persistent REPL runtime isolation/tool-callback policy | REPL unavailable until worker isolation and callback mediation pass |

## 17.5 Evidence law

For implementation facts:
exact local source/tests > Git history > immutable upstream source > official docs > secondary explanation.

A Markdown contract, catalog row, schema, mock, benchmark claim or competitor feature never proves runtime support.

Statuses are distinct:
DESIGNED -> CODE_PRESENT -> WIRED -> TESTED -> VERIFIED -> RELEASED.

## 17.6 Change procedure

A true conflict is resolved by changing this file and the single topic owner, not by appending another audit chapter.

If a decision needs product/security/platform input, mark only that capability unavailable and continue unrelated work.

Historical architecture is preserved under docs/architecture-archive and cannot be used as implementation authority.

## 17.7 Approved staged provider migration and brand identity (2026-10-12)

Decision A-V2-27 amends only the future provider-transport direction under A-V2-01; the existing OpenCode-derived implementation stays canonical until tested migration. This is a DESIGN decision, not evidence of working integration.
- Direct mode: one HorizonCode Core session owner, with OMP pi-ai and pi-catalog as candidate inference, auth, model-compatibility, catalog and cost layers underneath. Do not adopt OMP AgentSession or its own tool/history owner.
- Native OpenCode mode: separate official installed OpenCode runtime via documented API/SDK/ACP. OpenCode owns that session; HorizonCode holds links, events and verified outcome. Exactly one conversation owner per session; no silent session transfer or double writes.
- Model pricing from one catalog enriched by Models.dev: record source, freshness, cache rates, effective charges and UNKNOWN vs FREE. No competing catalog or hidden fallback.
- OpenCode Go follows documented third-party access. Zen promotional free-tier eligibility is independently restricted and not guaranteed. Never spoof a native client or bypass provider access gates.
- Public npm package and primary CLI: horizoncode. Optional command alias: hzcode. Retain upstream @opencode-ai internal import names until a separately validated migration. No premature npm publication.
- Required gates: repeatable checkout, bounded test/build, real Guard mediation, native adapter lifecycle, streaming, cost accuracy, explicit permissions and independent outcome verification.

## 17.8 A-V2-28 — selective rival adoption and evidence-first implementation (2026-10-14)

This clarifies existing V1 contracts; it does not authorize another session owner, orchestration runtime, extension registry, native tool authority or new platform capability without its existing acceptance gate.

- **Adopt now:** one Guard/ExecutionHost mediation for enabled mutation origins, complete bounded ToolBatch, accurate UNKNOWN/cancellation, real acceptance evidence, V1/V2 parity and a lightweight direct coding path. Unsupported or opaque effect origins are disabled rather than falsely labeled safe.
- **Adopt behind benchmarks:** source-revision-safe Hashline as an edit dialect within `files.patch`; in-process read/grep/gix behind the existing tools only with equivalent open-time read scope/security and truthful partial results; early connection/lazy MCP; CoW worktrees preserving the existing resource lease/disk/dirty-state policy; optional read-only independent verifier, typed child deliverables and UI inspection.
- **Reuse:** current OpenCode-derived direct Session, transport, compaction, TUI, plugin/ACP/MCP surfaces when proved on the pinned fork; Rust canonical Goal/SpecVersion/Run/Task/Attempt/effects/evidence and existing supervisor.
- **Defer as defaults:** parallel best-of-N or 8 workers, new leader daemon, Rust TUI rewrite, full native shell, always-on classifier, snapcompact, unreviewed executable marketplace or hidden paid model calls.
- **Proof:** each candidate needs identical-task/model/platform baselines where possible; correctness, security, verification success, p50/p95 latency, resource/disk/tokens/cost and rollback. Compaction summaries cannot become authoritative task/lease state. Reviewers cannot invent new acceptance requirements after an evidenced PASS.

The single implementation-order decision and benchmark specification live in `docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md`; §14 governs effect/read security, §20 source placement, §21 pooling, §30 context, §31 measurement/UI, §32 tests and §42 source pins. Do not create another competing architecture chapter. Completion requires observed behavior, not another document.

## 17.9 A-V2-29 — optional-feature Settings and experimental release class (2026-10-14)

Every **user-selectable optional feature** has one discoverable setting in the existing config owner and a derived `FeatureExposureV1` metadata/state projection shared by TUI, web/desktop when present, CLI/SDK and command help. `experimental | beta | stable` is a release/stability class and is independent of implementation evidence and current availability. `experimental` is the official tag for dev-testing and early-access functionality; it defaults OFF and requires eligible build/channel plus explicit opt-in. Design-only capabilities remain visibly unavailable and cannot be enabled or called. Developer-only experiments do not accidentally appear as enabled controls in public builds.

The owning config retains requested/effective/source/lock/precedence/apply-boundary semantics from §16.8. The feature exposure schema is `contracts-v2/feature-exposure-v1.schema.json`, **not** a new registry. Every related tool/action uses the existing canonical §33 ID and ordinary Guard; experimental status/opt-in never overrides deny, sandbox, privacy, user provider/model choice or paid-call approval. A safe rollback and settings migration is required before promoting or retiring a feature. §16.15 owns UX, §33.28 synchronizes catalog metadata, §32 covers acceptance; the implementation checklist owns the execution gate.

## 17.10 A-V2-30 — JCode-informed resource-efficient execution (2026-10-15)

**Adopt the mechanisms, not JCode's competing ownership model.** The shared-process, headless-worker, memory-budget, cross-session file-activity, provider-doctor, adaptive-render and task-DAG findings are accepted HorizonCode product requirements, not evidence they already work. Implementation details remain with the existing owners: §01/§13 topology, §18 memory/operations, §20 local source seams, §21 leases/conflicts, §29 workers/DAG, §30 retrieval/cache, §31 UI, §32 evidence and §37 service interfaces. §42 pins the research sources. The implementation checklist owns sequencing and HANDOFF owns status.

- **Candidate shared kernel, no automatic cutover:** present main launches a Linux Rust `session_supervisor` per Session from `packages/core/src/session/supervisor.ts`. A single long-lived Rust service with virtual session scopes and shared read-only facilities is a benchmark-gated implementation direction, not existing behaviour. Retain canonical Core Session/messages, single Rust managed/effect owner, authenticated session isolation, scoped receipts and OS process/worker boundaries where required. No new provider loop, conversation store, policy engine, or independent scheduler.
- **Full-process resource control:** account for the entire host/kernel/session/child/LSP/MCP/build/test/REPL/render/index/cache/worktree tree, separately for local model inference; enforce capacity and pressure policy, accurate measured/estimated/unknown units, per-owner attribution and bounded recovery. Never silently kill user processes, abandon receipts, evict canonical data, or change the selected model/account to meet a budget.
- **First-class headless and foreground UX:** one execution authority and task/attempt identity for interactive and headless workers. Parent scope intersects child permissions; the scheduler prioritizes actual useful work, memory/disk capacity and integration collision risk. Long-lived shared services do not imply unbounded worker concurrency.
- **Practical diagnostics:** one explicit Provider Doctor with offline/catalog/full consent tiers; local redacted resource timeline; file-touch advisory index plus authoritative file-revision/lease fences; adaptive TUI refresh; bounded tool-tail and cache budgets; explicit native/open external-session import and resume, without dual ownership.
- **Proof before promotion:** same-machine task/model/repository baselines at 1/5/10/20 sessions, Linux PSS and RSS, macOS/Windows platform-specific private-memory measurements, cold/warm startup, idle/active/long-run growth, crash/replay, file-edit collisions and scoped denial. JCode's published figures are competitor measurements only, not HorizonCode guarantees.
- **No artificial omission:** all accepted capabilities remain in the product inventory and implementation plan; statuses `DESIGNED → CODE_PRESENT → WIRED → TESTED → VERIFIED → RELEASED` are stated honestly. Experimental setting and availability rules in A-V2-29 continue to apply. Optional self-development/canary code must use explicit developer opt-in, state fencing and rollback.
