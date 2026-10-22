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
| A-V2-18 | Safe artifact/Mermaid rendering is core; browser/DOM interaction is post-V1 | V1 artifacts render in CLI/TUI; browser adapters stay unavailable until a later scope decision |
| A-V2-19 | CodeMirror 6 is the preferred embedded code/diff editor | Monaco needs a measured ADR |
| A-V2-20 | Real-work task catalog is mandatory | Harness correctness and model ability measured separately |
| A-V2-21 | Contract convergence precedes new subsystem wiring | One schema/ID/error model per boundary |
| A-V2-22 | Discoverable command/provider/model-role/settings/Goal UX is adopted | One ActionDescriptor and existing auth/config owners |
| A-V2-23 | Safe SVG preview, deterministic charts, terminal Mermaid and artifact fidelity are adopted | Rendering is sandboxed and source-preserving |
| A-V2-24 | External source reuse is immutable-pin/provenance/license/test gated | Source inspection is not integration |
| A-V2-25 | DAP debugging and bounded persistent REPL are V1 coding-agent capability families; desktop/computer control is post-V1; built-in web search was promoted into V1 on 2026-10-18 (`DEC-V1-26`) | V1 DAP/REPL/web-search reuse Guard/ExecutionHost and canonical capability/provider owners; remaining deferred desktop/browser paths stay unavailable |
| A-V2-26 | Active architecture has one topic owner; research/audit/history are non-normative | Compatibility stubs may point to the owner but must not restate contracts |
| A-V2-34 | V1 coding productivity requires an explicit bounded direct-session workspace grant and CodeMode orchestration through the existing authorized tool tree | Routine in-sandbox workspace work is prompt-free after explicit grant; CodeMode composes existing tools but creates no authority |

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
3. The full provider response is collected and validated before any **mutation-class** local tool in that response executes. **Read-class** tools in **direct** Sessions may use the §14.3.1 read fast path after per-call validation (`DEC-V1-36`). Managed mutating Attempt chains remain strict.
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
| DEC-V1-03 | Linux distribution/kernel containment matrix; `horizoncode-sandbox` now exists and is wired in source through HostKernel's terminal and stdio preflight/dispatch paths (2026-10-19 source review); per-kernel product-effect containment and denial evidence remain open under P1 | Capability detect and fail closed; no "sandboxed effects" claim until the P1 containment matrix and denial tests pass |
| DEC-V1-04 | Third-party signing/marketplace/revocation | No unreviewed executable marketplace activation |
| DEC-V1-05 | WASM runtime/import set | WASM extension unavailable |
| DEC-V1-06 | Provider secret delivery/broker transport | **Decision 2026-10-19:** select a one-request, in-process, first-party ProviderTransport boundary. The SecretBroker lease binds secret version, requester, provider, operation digest, destination, purpose and expiry; only the transport receives minimum bytes immediately before one request and zeroes them afterward. No raw secret in config, general RPC, environment, child process, plugin/tool, logs or artifacts. Credentialed providers remain unavailable until durable OS storage, lease consumption/revocation checks, zeroization and no-leak transport tests pass; unsupported secure stores remain unavailable. **Rotation amendment 2026-10-19:** a versioned update names the existing SecretRef and expected current version; create requests omit both. The broker preserves that reference, atomically increments its version, and rejects missing/mismatched pairs or stale versions. |
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
| DEC-V1-20 | Web-search provider cost/auth/reliability matrix (V1; initial provider set and full matrix maintained with §37.5) | After one first-use query-sharing disclosure, use only the anonymous/free built-in cascade by default; BYO/authenticated/paid routes and grounded-model search require separate explicit enablement/consent; no hidden paid fallback; trusted HostKernel selects routes and records per-route provenance |
| DEC-V1-21 | DAP adapter/language/OS support matrix | Read-only debugger features only where verified; Eval/attach guarded |
| DEC-V1-22 | Persistent REPL runtime isolation/tool-callback policy | REPL unavailable until worker isolation and callback mediation pass |
| DEC-V1-23 | HorizonCode-as-MCP-server exposure to third-party MCP clients | Server mode unavailable in V1; MCP remains client-side (consume servers, confine spawned server processes) |
| DEC-V1-24 | Editor/IDE integration breadth beyond CLI/TUI (VS Code/JetBrains-class extensions; external ACP client) | No editor-integration claim in V1; ACP adapter §37.20–21 design stays post-V1 per A-V2-31. User-configured external editor launch from the CLI/TUI for prompt editing or an explicitly selected workspace file is in V1 under DEC-V1-33; this is not an editor extension or ACP integration |
| DEC-V1-25 | Checkpoint/rewind restore evidence (snapshot bounds, preview/refusal semantics, partial-restore UNKNOWN) | Rewind not claimed available until §14.19/§16.18/§31.18 are wired and CP-001/CP-002 pass on the exact revision |
| DEC-V1-26 | Built-in web search promoted into V1 + provider cascade model (user directive 2026-10-18; default/consent clarified 2026-10-21; retry boundary clarified 2026-10-22) | V1: the anonymous/free built-in cascade is enabled after one explicit first-use query-sharing disclosure; BYO/authenticated/paid routes and grounded-model search require separate explicit enablement/consent; auth 4xx (401/403/407) is recorded per route and falls through only to a separately enabled route; other non-rate-limit 4xx stops; HTTP 408/425/5xx may retry once after a durable response receipt; network retry is allowed only for a durable `NOT_DISPATCHED` proof that no request bytes left the process, at most once per enabled route; possible-send ambiguity remains UNKNOWN and is never retried; HostKernel owns route choice and per-route provenance; no hidden paid fallback |
| DEC-V1-27 | OS resource-limit guarantees | CPU/memory/process-count/FD guarantees remain unavailable until OS-enforced by the selected backend; profiles requiring them fail closed. Bounded admission/monitoring may be used only for dimensions it actually bounds/observes and never represents hard OS quotas |
| DEC-V1-28 | Direct-session permission modes and routine workspace grants | Direct Sessions expose independent sandbox and approval controls through `DirectSessionPermissionModeV1`: Ask for approval (`workspace-write` + `on-request`) is the default; Full access (`danger-full-access` + `never`) is an explicit user-selected mode that permits local file, network and process actions without routine confirmation; Custom selects both dimensions independently. `always` asks before every effect; `on-request` allows actions inside the selected sandbox and asks at its boundary; `never` does not prompt and acts within the selected sandbox. A mode never bypasses the common Guard, authenticated owner/scope checks, budgets, one-use leases, receipts, cancellation or UNKNOWN recovery. Full access does not claim OS confinement and carries a clear risk notice. Technical invalidity, stale authority, unsupported platform paths and unavailable required execution backends remain unavailable; approval choice does not fabricate OS guarantees. `DirectSessionGrantV1` remains the optional narrow reusable grant for workspace-code scope, when users prefer bounded grants. `WorkspaceCommandProfileV1` remains available for users who want named build/test limits; it is not required by Full access. Legacy `PermissionV1` never authorizes Guard. Adapted from Codex's orthogonal sandbox/approval model and explicit Ask/Full access modes; HorizonCode retains its own Guard and evidence lifecycle |
| DEC-V1-29 | CodeMode is bounded orchestration over canonical tools | Reuse the existing interpreter and model-facing `execute` function; canonical capability ID is `codemode.execute`. A bounded pure-computation script may complete with zero nested tool calls; it has no nested-effect receipt or aggregate nested receipt digest, while the outer helper process still uses its normal Guarded process-effect receipt. If nested calls occur, every wave must settle with per-call receipts and the result carries the ordered aggregate nested receipt digest. Run the existing interpreter in a short-lived helper process launched and supervised only by the existing Rust ExecutionHost. Select only the trusted packaged runtime selector `horizoncode:codemode:bun`; V1 has no Node fallback, Worker-thread runtime or second supervisor. Progressive discovery uses the existing CodeMode `$codemode.search` API over the current authorized tool tree. Existing MCP adapters may participate only through Core's normal dispatcher; there is no raw MCP client in the helper. The helper has no ambient filesystem, process, network, credential or registry APIs. Its bounded versioned stdio RPC carries code, tool-call requests/results, cancellation and terminal outcome; Core routes every complete wave through the authenticated SessionSupervisor ToolBatch path. One script has a 30s total deadline, <=64 KiB source/output, <=64 calls across at most 64 sequential waves of <=32, <=256 KiB arguments per call, <=512 KiB serialized arguments per wave and <=1 MiB serialized arguments across the script. HostKernel applies fixed `CodeModeResourceProfileV1` before first instruction: cgroup-v2 memory 536870912 bytes, CPU `100000 100000`, PIDs 64, and nofile 256. Every listed limit is mandatory and verified before the first instruction; if any limit or the packaged runtime cannot be verified, CodeMode stays unavailable on that backend. A versioned BLAKE3 digest binds the exact profile values. Expose only after protocol, dispatcher, cancellation/reap and Guarded receipt recovery are wired; §32.41 CM-001..CM-012 is integrated release acceptance |
| DEC-V1-30 | Managed effect waves bind before one-use lease issuance | Preserve legacy `attempt_effects_bound` for replay, but new ToolBatch waves append `attempt_effect_wave_bound` after approval and before any lease becomes consumable. One OwnerLog revision binds the exact Attempt, HostKernel batch/wave IDs, authenticated source-scope digest and ordered call/effect/capability/arguments/EffectIntent digests. Arguments and secrets are never stored. Refresh the managed scope and revalidate after the append, then issue per-effect one-use leases. Direct Sessions continue to use DirectTurnJournal. |
| DEC-V1-31 | Bounded managed DAG is part of V1 after the single-Task vertical is accepted | V1 includes bounded, concurrent Rust-owned managed Task DAGs. The one-Task Run is the prerequisite proving admission, guarded effects, independent verification and receipt settlement; it is not the final DAG ceiling. Expand only after that vertical passes final-revision acceptance. Each Task requires independent verifier evidence, exact workspace revision and settled receipts; Run success is an aggregate Rust decision over all required Tasks. Dependencies, disjoint write scopes or serialized workspace leases, limits, cancellation, UNKNOWN reconciliation and late-result fencing are mandatory. Until aggregate settlement passes acceptance, multi-Task dispatch remains unavailable. Direct Core child Sessions remain a separate lane and cannot satisfy managed Task evidence. |
| DEC-V1-32 | Direct request authorization and context pinning | An authenticated user prompt/continue authorizes the selected provider/model/account/endpoint/harness within configured policy; pin the exact normalized provider input and route before send, without a per-request HostKernel context bind. Drift, exceeded or unknown required limits stops before dispatch, with no hidden fallback. Direct Core owns its Session/request/context state; managed requests stay live-Attempt-bound. See §17.26 and §§12–15/30/32/37. |
| DEC-V1-33 | User-selected external editors in CLI/TUI | V1 supports user-owned editor profiles for prompt scratch and workspace files, including foreground terminal editors (`nano`, `vi`, `vim`, `nvim`) and GUI command-line launchers configured with a wait-for-close option (`subl`, `code`, `zed`). The normal interface remains a single-pane coding session with no Explorer, editor pane, or persistent side panel. These surfaces are opt-in through `/editor`: it opens the workspace Explorer as an overlay; selecting a file and choosing Open launches the saved editor profile. `/editor --side` is an explicit alternate layout that opens the Explorer/editor in a right-side pane; closing it returns to the single-pane session. Settings → Editors (reachable through `/settings`) selects the profile. The user selects the target; the model cannot choose an executable, arguments, environment, or target path. HostKernel resolves the exact profile revision and executable and starts it through the existing ExecutionHost. No shell parsing or raw Core process spawn. Terminal editors borrow the TUI terminal in a foreground PTY; GUI launchers must retain a wait handle until the edit is closed. The current DirectSession sandbox and approval mode governs the action. `workspace-write` requires verified OS containment of the editor process tree; if the backend cannot provide it, the route is unavailable there and the UI offers the already-defined explicit Full access mode with its warning. No editor extension protocol or ACP client is claimed in V1. Workspace writes settle as the `editor.launch` guarded effect with changed-path/revision receipt metadata; an exclusive workspace write fence prevents concurrent agent edits until close. See §§4.17, 12.22, 14.29, 16.20, 32.44 and 37.28. |
| DEC-V1-34 | Primary product objective: competitive software engineering capability | HorizonCode's highest product objective is to deliver strong end-to-end software engineering: task success and correctness, useful capability breadth, fast iteration, and reliable SWE workflows. UI defaults and permission friction should support that outcome without hiding useful capabilities behind always-visible surfaces. V1 evaluation must include real coding tasks and report correctness/pass rate, time/latency, tool/context usage, failures and recovery. Harness uplift comparisons must hold model/version, task set, tools, permissions, budgets and environment constant between baseline and HorizonCode arms. Competitor comparisons require reproducible matched evidence; public estimates or a favorable single task are not a claim that HorizonCode surpasses Claude Code, Codex, OpenCode or another agent. See P8 and §32.40 HUP-001..006. |
| DEC-V1-35 | V1 competitive adaptation inside existing owners | External products (mgrep, code-review-graph, Windsurf/Devin Desktop IDE, default cloud codebase indexes, LanceDB episodic memory, Wasm plugin runtimes) may inform algorithms and UX only. V1 release-critical work is the ordered adaptation list in §10.18.1: finish P1–P9 wiring and acceptance using pinned OpenCode/OMP/Codex patterns. Do not add a second repository index/graph authority, default remote embedding sync, or competitor MCP as canonical RepoIntel. Optional third-party MCPs remain client-side, routed, and non-authoritative per §29 and `docs/agent-tool-routing.md`. Post-V1 surfaces stay unavailable per §10.12 and A-V2-31. Traceability: §32.47, §30.25, §42.21, derived §45.29. |
| DEC-V1-36 | Direct-mode migration parity (OpenCode / Cursor / Claude Code / Codex-class UX) | Pair programming stays the default: **no Goal**, provider send never blocked on kernel READY for non-effect turns, **session-warm** kernel IPC, **read fast path** (§14.3.1) so read-class tools may run while the provider response is still streaming after per-call schema validation; **mutations, shell, MCP writes, and hosted effects** still require closed-batch admission, Guard, PREPARED, lease and receipt. Default UX preset **Coding (recommended)** (§16.19.1) matches competitor norms: Workspace write + ask on boundary, with one-time session grant for routine reads/edits and pinned workspace command profiles for tests. Acceptance: §32.49 `PERF-DIRECT-*`, §31.24, migration matrix §46-V1-MIGRATION-PARITY.md. Managed Attempts keep stricter batch ordering for mutating chains. |
| DEC-V1-37 | Horizon Coding Profile (speed + accuracy + reliability bundle) | One composed default for direct Sessions: §16.19.1 permissions, §30.28 speed compiler, §30.29 accuracy contracts, §30.30 reliability/long-horizon defaults, §33.33. Measured via §32.49–52 and HUP-001 arm labeled `horizon-coding-profile`. |
| DEC-V1-38 | Tool and skill exposure tiers | Three tiers §33.32; **skills always catalog-visible** (metadata); `skill` + `skills.search` in **Core** tier; **`builtin.horizoncode`** documents full product integration. MCP third-party only via routed client choice (`DEC-V1-35`). Acceptance §32.51. |

**DEC-V1-33 UX clarification (2026-10-22):** Explorer/editor UI is opt-in, not a default
coding surface. The session starts and returns to a single-pane layout. `/editor` opens
Explorer as an overlay; `/editor --side` explicitly opens it in a right-side pane. The
selected editor profile is configured in `/settings` → Editors. No default button,
persistent sidebar, or model tool may launch an editor or expose the Explorer UI.

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
- Public npm package and canonical user-facing CLI command: `horizoncode`. **Amended 2026-10-18:** the user directed that both `horizoncode` and `hzcode` start the same CLI entrypoint and runtime; `hzcode` is a shipped short command name, not a second implementation or runtime. The user also directed the staged HorizonCode CLI/naming refactor (launcher, installer and user-visible names first) to begin within the V1 scope. Retain upstream @opencode-ai internal import names and private workspace package IDs until a separately validated migration. No premature npm publication.
- Required gates: repeatable checkout, bounded test/build, real Guard mediation, native adapter lifecycle, streaming, cost accuracy, explicit permissions and independent outcome verification.

## 17.8 A-V2-28 — selective rival adoption and evidence-first implementation (2026-10-14)

This clarifies existing V1 contracts; it does not authorize another session owner, orchestration runtime, extension registry, native tool authority or new platform capability without its existing acceptance gate.

- **Adopt now:** one Guard/ExecutionHost mediation for enabled mutation origins, complete bounded ToolBatch, accurate UNKNOWN/cancellation, real acceptance evidence, V1/V2 parity and a lightweight direct coding path. Unsupported or opaque effect origins are disabled rather than falsely labeled safe.
- **Adopt behind benchmarks:** source-revision-safe Hashline as an edit dialect within `files.patch`; in-process read/grep/gix behind the existing tools only with equivalent open-time read scope/security and truthful partial results; early connection/lazy MCP; CoW worktrees preserving the existing resource lease/disk/dirty-state policy; optional read-only independent verifier, typed child deliverables and UI inspection.
- **Reuse:** current OpenCode-derived direct Session, transport, compaction, TUI, plugin/ACP/MCP surfaces when proved on the pinned fork; Rust canonical Goal/SpecVersion/Run/Task/Attempt/effects/evidence and existing supervisor.
- **Defer as defaults:** parallel best-of-N or 8 workers, new leader daemon, Rust TUI rewrite, full native shell, always-on classifier, unreviewed executable marketplace or hidden paid model calls.
- **Snapcompact:** DEFERRED/UNAVAILABLE in V1, not merely default-off. The transient imaging transform and persistent archive-compaction method are separate; neither is implemented. Reconsider only as a same-selected-model ContextService projection after P1.3 and context accuracy/cost/privacy proof; canonical history and task/lease state remain authoritative.
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

## 17.11 A-V2-31 — Linux-first CLI/TUI V1 scope and selective source intake (2026-10-16)

This user-approved scope decision supersedes the prior 2026-10-16 plan entry that deferred LSP/DAP/REPL, settings/UI, workers, resource features and related capabilities. It changes delivery scope, not implementation status or Guard policy.

- **V1 surface/platform:** ship the Linux/WSL-first CLI/TUI. Web, desktop, browser automation/attached-browser and desktop/computer control are post-V1 and unavailable in V1. Keep native Windows unavailable until native tests pass. Safe artifact/Mermaid rendering remains a CLI/TUI capability.
- **Amendment (2026-10-18; historical wording superseded by DEC-V1-20/26):** built-in web search (`web.search.*`, §37.5 `WebSearchBrokerV1`) is promoted into V1 — built-in default route + optional BYO-key providers (initial set Brave, Exa; matrix `DEC-V1-20`) forming one ordered cascade with fail-through; Settings control (§16.7) and explicit cost/auth provenance. The later decision requires first-use query-sharing consent for the anonymous cascade and separate per-route auth/cost consent for authenticated routes; route enablement alone is not consent.
- **V1 feature scope:** LSP, DAP, bounded REPL, settings/provider/model UX, streaming/rendering, artifacts/analytics/automations, bounded worktree/resource pools, quotas, cross-model suites, subagents/workers/DAG, file-conflict signals, Provider Doctor, session import, bounded caches/local recall, and TUI performance are V1 goals. The order remains P1.3 Guard → P2 single managed vertical → bounded worker fan-out and remaining feature modules; no effectful origin becomes available before Guard proof.
- **Source preference:** adapt compatible non-OpenCode providers and CLI/TUI settings/visual patterns from the immutable Oh My Pi reference; use the official version-appropriate OpenCode API/SDK path for explicitly selected OpenCode-owned sessions. SDK/API use does not promise every provider model, subscription or free-tier entitlement and does not override the one-session-owner law. Verify supported entitlements through documented user auth and actual acceptance tests.
- **Naming and provenance:** new adapted first-party Horizon modules, packages, folders and configuration identifiers use HorizonCode identity as they are introduced. Preserve third-party authorship, licenses and genuine upstream dependency names. This does not authorize replacing the pinned `opencode/` snapshot or a global package migration.
- **Status authority:** `implementationtov1release.md` is the main-agent-maintained V1 goal/status map; `HANDOFF.md` records observed implementation evidence; the operative plan owns dependency order; topic owners remain normative. No tracker entry promotes runtime status without exact tests and evidence.

Affected delivery/surface/resource owners: §§10, 16, 18, 20, 21, 29, 30, 31, 32, 33 and 37. Their scope notes and acceptance filters must be kept consistent with this decision; the tracker records the exact source map and open gates.

## 17.12 A-V2-32 — adaptive repository intelligence within existing owners (2026-10-17)

This is an implementation clarification for V1 RepoIntel/LSP/DAP/REPL; it adds no second index, policy engine, process supervisor, resource controller, or capability registry.

- One rebuildable RepoIntel index may share an immutable base only when repository/root, exact source revision, parser set, and read-scope/policy pins match. Per-Session/Attempt overlays are immutable owner-bound snapshots; a query never selects another actor's overlay. Existing RepoGeneration and content digests remain the freshness authority—do not add a competing revision counter.
- `lightweight | adaptive | full` are requested/effective analysis profiles over the same RepoIntelService. They control which optional analysis may be requested, not permissions. Missing or invalid policy resolves conservatively to lightweight. A setting change alone never starts a process, performs network access, or warms a model. Full permits richer on-demand analysis; prewarm is a separate explicit action subject to normal authorization and resource admission. Embeddings remain separately selected.
- Each result identifies the exact workspace/source generation and overlay digest served, source kind, completeness, freshness, and typed stale/unavailable/fallback reason. Query output is evidence, not write authority. Filesystem changes still require the canonical files.patch/Guard path and current digest/lease checks.
- Starting a supervised LSP/DAP/REPL or other helper is an effect and requires existing Guard, ExecutionHost, resource admission, and process ownership. A broker query pin is only a bounded read-lifetime reference, not a capability or resource lease. Editor-owned processes cannot be stopped, restarted, reconfigured, or evicted by HorizonCode.
- Resource pressure may throttle new indexing, defer optional embeddings, evict unpinned rebuildable caches, or stop an idle Horizon-owned service after query pins drain. It must not change the selected provider/model, terminate foreign or active effect processes, release unsettled receipts, or silently label fallback results current.
- Complete-batch validation is a pre-dispatch guarantee, not a transaction. Once dispatch begins, each operation is settled from its own receipt/observation; failure does not imply rollback of prior effects. Uncertainty remains UNKNOWN and is reconciled before dependent work or retry.

Owners: §§14.3–14.5/14.15–16, 16.15, 18.18, 30.7–10/30.14/30.20–22, 32.4/32.14/32.23/32.28/32.32–33, and 37.6–8/37.16–18; §12.16 owns any RepoIntel query wire schema. Existing §33 capability IDs and §18 resource/pressure owners remain canonical. These clarifications are DESIGNED until schemas, runtime paths, negative tests, and platform evidence pass.

**RepoIntel document-read extension (2026-10-19):** LSP text synchronization may read
workspace documents through additive `repo-intel.v1/read_document` on the existing
HostKernel service. The body contains no principal, root or permission claim;
authenticated RepoRead context, current Guard `files.read`, registered Location ownership,
exact workspace revision, no-follow path traversal and strict byte/UTF-8 bounds remain
HostKernel-enforced. This adds no service, filesystem owner or supervisor and grants no
LSP edit authority. §12.18 owns the wire shape; §§30 and 37 own the service flow; RD-017
and LS-011 own acceptance. It is unavailable unless the authenticated read boundary is
negotiated and current.

## 17.13 A-V2-33 — VEO note review and V1 phase allocation (2026-10-19)

The user supplied `extra_some_Stuff.md` for critical review. The full note was compared with the pinned product source, current competitor documentation and the normative HorizonCode owners. Selected mechanisms refine existing V1 phases; they do not add a second architecture or postpone V1. The note's runtime, cost and performance claims are not evidence.

- **P1 — Guard and ExecutionHost:** every child/helper action uses authenticated owner scope and the same Guard/ExecutionHost. Confinement, bounded context, cancellation and UNKNOWN/restart rules remain mandatory. RepoIntel references and child output never grant write authority.
- **P2 — managed vertical:** bind dispatched work to accepted SpecVersion, Task, live Attempt, profile/capability ceiling, workspace/source revision and budget; return typed bounded artifacts/evidence; independently verify the actual final workspace revision. Deterministic checks may block settlement only when named by accepted criteria and budgeted; they cannot grant authority or change criteria. No model-authored PASS or caller-supplied identity/evidence.
- **P3 — RepoIntel:** provide bounded source-grounded navigation with generation/revision-bound references, explicit coverage/fallback provenance and stale rejection. Mutations continue through `files.patch` plus Guard. Broader parser coverage requires measured completeness and resource evidence.
- **P6 — provider/settings/skills:** report cache and cost as provider-reported, measured, estimated or unknown, bound to the selected provider/model/request. A proposed skill/profile remains inert until existing registry, permission and activation rules accept it.
- **P7 — artifacts/events/rendering:** child summaries are compact projections backed by immutable evidence refs; preserve `full`/`head_tail_sample`/`failed` wire fidelity (`FULL`/`SAMPLE`/`FAILED` are UI labels only). Durable owner transitions replay from their source cursor; progress/paint events are bounded, redacted and coalescible. Analytics cannot change task or verification truth.
- **P8 — resources:** account for child, test, index, artifact and verifier work within existing reservations and per-owner attribution. Resource/cache pressure cannot silently change provider/model, drop unsettled receipts or kill a foreign process.

The operative phase ledger maps these refinements to P1/P2/P3/P6/P7/P8 acceptance; P4/P5/P9 retain their existing V1 scope. VEO-F1..F8 are optional post-V1 extensions only, not additional V1 release phases. HLD/LLD flows, fields, event projections and acceptance are in §§1.14, 3.21, 4.13, 12.18, 29.20, 30.23, 31.19, 32.38 and 37.22. Those topic owners are authoritative; no runtime wire shape is enabled until its machine schema and cross-language fixtures are updated.

**Contract closure rule (2026-10-19):** P2 owns `contracts-v2/delegation-binding-v1.schema.json`, its shared golden fixture and Rust IPC decoder tests. Binding and new `ManagedAttemptScopeV1` envelope u64 epoch/revision values are canonical decimal strings in private MessagePack; the binding digest is domain-separated BLAKE3 over its fully validated canonical map. Missing trusted Attempt/profile/context/workspace/capability/budget/resource state or a missing/revoked live lease denies before effect preparation. This is not a new public API or event bus. Existing owner streams/cursors remain canonical; P7 may project semantic lifecycle labels for UI without introducing new OwnerLog kinds. See §§4.13 and 12.18.

**Managed profile/context and capability-source ruling (2026-10-19):** Core Config owns the single `AgentProfileV2` definition/revision source; Core `ContextService` owns bounded `ContextSelectionV1` compilation and `ContextLedgerV2` remains a read-only projection. Rust stores only immutable per-Attempt profile/context refs and digests in OwnerLog. Initial managed V1 accepts built-in and explicitly user-owned profiles; project/plugin/external profiles stay unavailable until trust resolution is executable. `SpecVersionV1.capabilityScope` is an explicit sorted canonical-ID list included in the proposal digest and distinct reviewer projection; `TaskV1.requiredCapabilities` must be its subset. `AgentProfileV2.capabilityCeiling` is explicit, sorted and unique. Empty/missing Spec or profile scope means no effects. No capability is inferred from prose or path/tool/MCP globs. The effective ceiling intersects Task requirements, accepted SpecVersion scope, profile ceiling and current Guard policy; it never grants an operation or replaces Guard/one-use effect leases. `capability-registry-v1.json` is a design-time ID/alias seed only, not a runtime registry/availability proof; P1 must resolve every dispatched ID against its live Guard/capability registration. See §§3.21, 4.13, 12.4, 12.18, 29.2 and 37.22.

**Authenticated managed profile proof transport (2026-10-19):** Do not add a profile-registration service principal, public endpoint, reusable caller-held profile token, or Rust global profile registry. During managed admission Core sends the complete strict `AgentProfileDefinitionV2` (without `definitionDigest` or `permissionCeilingDigest`) in the existing authenticated Core→HostKernel private IPC request. HostKernel derives Core process identity from its authenticated OS peer/handshake/fence and accepts a delegated user subject only from the out-of-body `AuthenticatedPrincipalV1::ServerAuth` envelope produced by validated Core middleware. It validates the definition against accepted Task/Spec and the V1 profile-source allowlist, computes domain-separated BLAKE3 digests from the validated canonical MessagePack value using the existing encoder, and stores only immutable per-Attempt refs/digests atomically with the binding. The effective capability-ceiling digest remains separately minted by P1 from Task ∩ Spec ∩ profile ∩ current Guard policy. The existing `contracts-v2/agent-profile-v2.schema.json` is the canonical machine contract and must be corrected to §29.2; its definition projection rejects digest fields. Golden Rust/TypeScript parity and malformed/unauthenticated zero-mutation tests are required before any managed effect is enabled.

**Direct child profile authority ruling (2026-10-19):** The same Core Config-owned immutable `AgentProfileV2` revision is authoritative for direct-session children. `TaskTool.subagent_type` may remain a compatibility selector only when it resolves to one stable profile ID/revision; legacy Agent configuration is migration input, not authority. The resolved profile must drive actual runtime model, harness, instructions, tool exposure and parent-intersected permissions before its revision/digests are pinned into the child Session and Direct Attempt. Resume must recover that exact revision; no latest-revision or parent-model fallback is permitted. Until the profile catalog, migration/alias mapping and runtime projection are wired, Task dispatch/resume must fail closed before child creation/prompting. This extends A-V2-02/12/21 and §29.20 without adding another profile registry or session owner; acceptance is VEO-017.

**LSP/DAP launch-profile source ruling (2026-10-19):** The user selected existing trusted Core Config as the source projected to HostKernel for LSP/DAP process launch. Core Config remains the profile/config owner; HostKernel validates the authenticated, immutable launch-profile projection, resolves the executable and admits it through the one existing Guard/ExecutionHost supervisor. Do not create a second process supervisor or independent mutable launch-profile registry. Project/plugin/external launch definitions and project-selected executables/config remain untrusted and unavailable until their trust resolution is explicit; P4 cannot supply raw executable path, argv, cwd, environment, PID or process handle as authority. HostKernel-minted `HostProcessRefV1` remains the only process identity. The strict machine contract, cross-language fixtures, Guard lease binding and Linux confinement acceptance must exist before any LSP/DAP launch is enabled; REPL remains unavailable while required OS resource limits are unenforced.

**Launch profile projection contract (2026-10-19):** The strict profile definition and
logical reference are `ExecutionLaunchProfileDefinitionV1` and
`ExecutionLaunchProfileRefV1` in §12.20. The profile binds a configured executable
selector, immutable literal argument vector, `registered_location_root` cwd policy and
`sanitized_host` environment policy. No shell interpolation, template expansion or
per-launch executable/argv/env/cwd override is permitted. DAP adapter authorization does
not authorize a debuggee launch/attach; that action requires its own Guard decision and
lease. The schema and cross-language fixtures are one private IPC contract, not a new
registry or supervisor.

Reject as product requirements: a new VEO daemon/runtime/event bus/index/authority plane, prescribed Firecracker deployment, TLS credential interception, hidden provider escalation, self-registering agents/skills, autonomous production changes, or competitor performance numbers. Browser/desktop and production/data operations remain outside Linux/WSL-first V1 under A-V2-31.

## 17.14 Core Config child-profile selector mapping (2026-10-19)

Core Config remains the sole `AgentProfileV2` authority for direct and managed child work.
Task's `subagent_type` is lookup input only. Core Config must resolve it through an explicit
`agent_profile_selectors` entry `{ selector, profileId, revision }` from global user-owned
`opencode.json`/`.jsonc` to one immutable enabled profile revision before dispatch; project
configuration cannot define or override it. Neither display names, legacy Agent names, request
bodies nor model output are implicit mappings or authority. Duplicate declarations (including
identical entries), conflicting mappings and missing, disabled, or wrong-owner targets fail
closed. A profile update does not silently retarget an existing selector; the mapping must be
changed deliberately, and an existing child resumes only its exact Session-pinned revision. P2
owns Config/schema/runtime integration; VEO-017 owns stale,
conflict, remap and resume acceptance. This resolves the ambiguity between mutable selector UX
and immutable profile authority without retaining legacy Agent execution.

## 17.15 Attempt-bound batch lease revision ordering (2026-10-19)

For both managed and direct child effects, the one-use Guard lease binds the **post-bind**
Attempt scope and exact effect edge/intent. HostKernel completes whole-batch validation and Guard
evaluation first, resolves required explicit approval, atomically binds the exact batch effects
to the live Attempt, refreshes `expectedManagedRevision` from the durable OwnerLog, rechecks the
same authenticated Attempt, edge set, workspace head, policy and approval, and only then issues
the one-use lease. A pre-bind challenge can retain its initial scope as evaluation provenance,
but it cannot yield a lease until HostKernel has verified and made a one-time transition to the
post-bind scope. Even an ALLOW path defers lease issuance; ASK requires its exact approval to
remain current. No issued lease is mutated, no caller-provided rebase is accepted, and any
intervening owner/workspace change denies and requires reconciliation/new authorization. This
avoids allowing the batch's own OwnerLog append to invalidate a lease digest while preserving
the current-revision fence at approval and dispatch. P2 owns HostKernel sequencing and ordering;
P1 owns Guard/EffectHost and supplies the authenticated one-use authorization interfaces. P2 owns
the managed Attempt batch contract; P1 also closes the direct Attempt path. See
§§12.19, 14.3, 32.38 and 37.22.

`workspaceRevision` remains the current receipt-chain head, not an immutable identity field.
After a successful write receipt, HostKernel may return a refreshed managed scope with both a
new OwnerLog revision and the exact new chain head. Core accepts it only as the correlated
response to that HostKernel receipt/reconcile operation; the next HostKernel boundary
independently recomputes the registered workspace and ordered receipt chain. Atomic batch bind
alone preserves workspace revision and advances OwnerLog by exactly one. Error/UNKNOWN/cancel/
restart does not produce a dispatchable refresh. This prevents legitimate writes from
stranding the next model turn without letting caller-provided workspace digests rebase an
Attempt.

## 17.16 Managed root coordinator execution proof (2026-10-19)

The first managed Task's `DelegationBindingV1.parentExecutionID` refers to a HostKernel-minted,
durable logical root-coordinator `WorkerExecutionId` bound to the authenticated top-level Core
Session that coordinates the Run. This record supplies lineage and owner epoch; it does not
create a second Core/model runtime or a separate worker process. HostKernel resolves principal,
Session/Location, OwnerLog and current transport/process incarnation from authenticated owners,
never from request JSON. The managed child Attempt retains its own RESERVED P8 budget/resource
leases; shared Core process usage is attributed once and no separate root-worker quota is
fabricated. Nested Task parents continue to require an active claimed WorkerExecution proof.
P8 owns the durable root/worker owner facts and proof variants; P1 composes them with
authenticated Attempt/profile/context, current workspace, Guard ceiling and child lease before
atomic binding. P8 first reserves against immutable pre-admission pins, then attaches the
HostKernel-minted DelegationBinding digest to that still-RESERVED child record before claim or
dispatch. Missing authenticated process incarnation or any stale/mismatched pin fails closed.
Acceptance is VEO-021; no fan-out opens until P1 Guard/ExecutionHost gates pass.


## 17.17 Approval precedes Attempt effect binding (2026-10-19)

The common Attempt-bound effect order in §17.15 also governs managed verifier effects. Before
approval, HostKernel may persist an immutable, challenge-bound candidate intent for reviewer
display, but it must not append an effect edge or verifier intent to the Attempt OwnerLog and
must not issue a lease. Once the exact challenge has required approval, HostKernel atomically
binds the complete authorized effect/intent set, obtains the refreshed OwnerLog scope, rechecks
the current approval, authenticated Attempt, exact edges, workspace head, policy and leases,
and then issues one-use leases. An unchallenged ALLOW follows the same bind/refresh/recheck
sequence without a human approval step. This removes wording in §§12.19–12.20 and §14.3 that
could be read as mutating the Attempt before its reviewer decision. The candidate intent is
review material only; it never grants authority or permits dispatch. P2 owns HostKernel sequencing
and durable Attempt-event ordering; P1 owns Guard/EffectHost authorization and supplies the
interfaces HostKernel invokes. VEO-022 covers approval denial/staleness,
pre-approval no-mutation, retries, cancellation, crash and lease fencing.


## 17.18 Explicit managed Run start (2026-10-19)

The user accepts an immutable SpecVersion, then Core submits a bounded task plan. Rust records
the Run and exact profile-pinned dependency Tasks in a non-dispatchable PLANNED state; all Tasks
remain unready. The user separately invokes authenticated `goal.start` for that Run. Rust
validates the trusted actor, exact current accepted SpecVersion, Goal revision and complete
unchanged plan, recomputes its canonical Task-set digest and records it in the durable start
event, then atomically transitions the Run to RUNNING and marks only dependency-root Tasks
ready; downstream Tasks remain unready until predecessors settle successfully. The request cannot provide Task/profile data. Repeating the same idempotency key and
pins returns the same transition; key reuse with different pins conflicts. Stale, unauthorized,
superseded, incomplete-plan and terminal state reject without dispatch. Run start grants no
effect authority: Task/Attempt admission, worker/resource reservation, Guard evaluation,
approval where required, and per-effect one-use leases remain separate mandatory gates. P2
owns the Rust transition plus authenticated Core/API/SDK/TUI path; acceptance covers stale
revision, wrong actor, exact retry, key conflict, duplicate start and no dispatch before
downstream admission.

The initial V1 verifier vertical accepts exactly one coding Task per Run, and that Task covers
the accepted criteria set. Core plan creation and the canonical Rust reducer keep new
multi-Task plans unavailable until per-Task verification, conflict-safe leases/recovery and
aggregate Run settlement are implemented. Under DEC-V1-31 these are prerequisites to the
required bounded managed DAG capability in final V1, not a post-V1 deferral. Historical
multi-Task records remain replayable; they cannot dispatch while the aggregate contract is
incomplete (see §12.19 and DEC-V1-31).

Legacy public HostKernel operations that could create a RUNNING Run or append Task inputs
outside this plan/start sequence are unavailable; historical OwnerLog events remain replayable
for recovery but cannot authorize a new dispatch path.

**Pre-admission worker ordering (2026-10-19):** HostKernel alone mints opaque
`TrustedPreAdmissionPinsV1` from authenticated identity and the current accepted Ready Task,
SpecVersion, profile/context, Guard ceiling, workspace, budget and parent lineage. P8 reserves
from those pins and returns `ReservedWorkerLeaseProofV1`; P1 then atomically appends Attempt,
DelegationBinding and the exact lease refs; P8 durably attaches the canonical binding digest
before claim. Authenticated one-use `managed.claim_dispatch` then returns the opaque
`ManagedDispatchHandoffV1` to the existing Core TaskTool. Request-supplied IDs/digests never
substitute for these proofs. Crash or lost response retains RESERVED/UNKNOWN/quarantined state
until OwnerLog reconciliation; no timeout release or automatic relaunch. The detailed sequence
is in §37.22.

**Authenticated root process context:** HostKernel receives a private typed projection of the
OS-authenticated Core peer identity from the listener, including PID/UID/GID, executable
identity and process-start identity. It binds that context to the negotiated Core process
incarnation and root-coordinator proof. These facts never come from RPC payloads; an unavailable
peer/start identity keeps managed admission unavailable. FrameFence epoch/nonce is not OS
process identity.

**Core prompt dispatch fence:** after receiving and durably persisting the opaque handoff, Core
calls authenticated `managed.consume_dispatch`. P8's OwnerLog provides a durable one-use claim
proof and opaque nonce/cursor; P1 validates it and appends the consumed marker to the canonical
managed-control OwnerLog, with no cross-log atomicity assumption. The marker binds exact
handoff/Attempt/Binding/current epoch and idempotency key; exact retry returns the same receipt
and mismatched reuse conflicts. Core records the receipt and pending prompt state before calling
the provider. A restart after consume with ambiguous provider outcome is UNKNOWN and cannot
automatically repeat the model call. This fence does not grant effect authority or replace Guard
for tools.

P8 restart recovery retains pre-admission RESERVED worker IDs across timeouts and owner-epoch
changes. Release requires P1's opaque `ManagedReservationReconciliationProofV1`: either the exact
candidate is durably fenced as never admitted/dispatched, or its exact Attempt is terminal with
no effect dispatch/UNKNOWN. P8 verifies the reservation remains RESERVED and unclaimed. Ambiguous
or claimed work stays quarantined until receipt/process reconciliation; no timeout proves safety.

**Pre-admission candidate renewal:** P8's `NotAdmittedNoDispatch` reconciliation durably
tombstones the exact candidate reservation; its worker/ticket/candidate Attempt identity is
never reused. P8 returns an opaque receipt bound to the tombstone OwnerLog cursor/event digest,
candidate IDs, pins digest, worker-pool revision, reconciliation-proof digest, receipt digest and
terminal `EXPIRED` outcome. Only after HostKernel validates that
receipt may it submit a private `AbandonPreAdmissionCandidate` transition to ManagedControl.
That transition binds the exact current READY Task revision, admitted attempt count, candidate
generation, Attempt ID, pins digest, P8 tombstone cursor, HostKernel epoch/process incarnation
and delivery ID, then increments the Task's durable candidate generation. Candidate IDs bind
Task ID plus both persisted counters: admission increments `attempt_count`, while a verified
pre-admission tombstone increments `candidate_generation`. An exact delivery replay returns its prior
receipt; changed proof or generation conflicts. P1 derives a fresh deterministic candidate
Attempt/idempotency identity from the Task and persisted counters. Neither a request nor a
timeout can choose or renew candidate identity. This transition only permits a new pre-admission
reservation attempt; it creates no Attempt, worker claim, provider dispatch or effect authority.


## 17.19 Managed child resource and worktree admission source (2026-10-19)

HostKernel derives managed child admission limits only from the authenticated current Run, accepted SpecVersion, Task-pinned AgentProfileV2 and P8's durable pool state. Each child Attempt reserves one `ActiveWorkers` unit; admission is bounded by both the WorkerPool configured live-worker ceiling and the accepted SpecVersion `maxWorkers`. This is bounded scheduling/accounting, not an OS resource limit. Memory, CPU, disk and file-descriptor measurements may inform backpressure and monitoring, but HorizonCode must not claim those resources are enforced until the selected OS backend proves enforcement. An explicit Spec memory/disk limit remains unavailable when the platform cannot enforce it; missing values are never replaced with invented per-worker quotas.

The child lease deadline is derived from trusted profile `limits.wallTimeMs` when configured, otherwise the accepted SpecVersion `maxRunDurationMs`, and is capped by the existing 24-hour worker lease ceiling. HostKernel persists the authenticated `goal.start` time so later admission uses remaining Run time rather than restarting the full Run budget for each Task. Expiry fences new use but never releases a RESERVED/CLAIMED lease or proves that a process/effect is absent; cross-owner receipt reconciliation remains mandatory.

The selected worktree ID and base-revision locator come only from an eligible P8-registered, clean worktree in the Goal's authenticated workspace binding. Registration/creation and current cleanliness facts must come from the guarded worktree lifecycle; callers cannot select a path, ID or base revision. The worktree base locator and HostKernel-measured workspace content digest are separately validated and pinned. No eligible registered worktree, unknown resource capacity, unsupported requested OS limit, or stale Run/Task/profile state keeps the relevant admission unavailable. This decision does not enable fan-out or bypass P1 Guard/ExecutionHost.


## 17.20 Managed TaskTool execution uses the existing Core process (2026-10-19)

`ManagedDispatchHandoffV1` is consumed by HorizonCode's existing Core `TaskTool`. A managed
child is a logical Core child Session/Task/Attempt within the existing Core runtime; V1 does not
spawn a second model-host or managed-worker executable. The Task's immutable Core Config
`AgentProfileV2` revision selects its model/harness and bounded child policy. P8's WorkerExecution
is durable logical lineage plus resource/worktree lease identity, not process-spawn authority.

All actual shell/process and other mutations still pass through the single P1 Guard and
ExecutionHost supervisor under the live Attempt lease. P8 claim does not create or authorize an
OS process. The earlier Core Config→HostKernel executable-profile decision covers supervised
LSP/DAP launches and does not add a managed Task executable contract.

Each managed Task executes in a distinct durable Core child Session with `parentID` set to the
Run's root/coordinator Session. The Run `SessionLink` and P8 root-coordinator lineage remain
bound to that root Session; the admitted Attempt, P8 child reservation, prompt-pending record and
Guard scope bind to the Task child Session. Core creates/reopens that child through its trusted
managed coordinator and pins Goal/Run/Task/Attempt/profile/handoff metadata before prompting.
The model and Task tool arguments cannot supply Task/Attempt/session selectors. Child-session
identity does not grant authority; HostKernel still resolves the Rust-selected Task and validates
its authenticated owner, immutable profile pin, live Attempt and P8 binding.

## 17.21 Managed child profile content is revalidated at claim and consume (2026-10-19)

Core resolves the Task-pinned `AgentProfileV2` revision from its authenticated Config service.
Because Core does not own the canonical Rust domain-separated MessagePack digest implementation,
it must not independently mint or infer `definitionDigest` or `permissionCeilingDigest`. The
authenticated `managed.claim_dispatch` and `managed.consume_dispatch` requests carry the exact
resolved profile definition. HostKernel strictly decodes it, recomputes both canonical digests,
and compares profile ID/revision and digests to the durable Task pin, `DelegationBindingV1` and
P8 reservation pins before claiming or consuming the handoff. Content drift, missing profile
content or a changed permission ceiling fails closed before the child prompt is sent. The request
content is evidence to compare against Rust-owned pins; it is never an authority source.
### 17.22 Core SessionLink identity and managed Run start

The managed Run starts only through authenticated explicit `goal.start` after an accepted
SpecVersion and a complete PLANNED Run. Core resolves the selected active top-level Session against
authenticated principal, Goal, project and workspace. Core supplies the trusted durable
SessionLink projection; HostKernel validates its owner and exact Rust ACK cursor, stamps the live
OwnerLog/process epoch, and Rust pins the link in the same idempotent start transition. Start
creates no Attempt or effect lease.

For Core sessions, `sourceStoreID` is a generated immutable identity persisted in the Core Session
database; `sourceInstanceID` is generated and persisted on the matching project-directory row;
`sourceEpoch` is a per-Session source-lineage generation, initialized to 1 and advanced only by an
explicit transactional reset/replacement. Neither process restart nor ordinary append changes
these identities. Paths, timestamps, request metadata and process epoch cannot substitute for
them. `SessionSupervisor.sessionProjectionCursor` supplies the exact durable Rust SessionProjection
ACK cursor with its BLAKE3 receipt digest. A missing/ambiguous identity or cursor keeps start
unavailable. This decision aligns with §12.3 and the Rust `SessionLink` fields.

The Core sourceDigest is SHA-256 over the domain `horizoncode.session-link.source.v1\0` and the
fixed §12.3 ordered UTF-8 projection fields, each prefixed by its unsigned 64-bit big-endian byte
length. Null latest message/part refs encode as empty fields; transcript content is excluded.

## 17.23 Guarded managed worktree lifecycle (2026-10-19)

Managed worktree acquire/inspect/release is a scheduler/P8 lifecycle operation, not a
model-selected Core ToolBatch. Core callers cannot supply a worktree path, executable or argv.
Use private authenticated control traffic carrying an opaque allocator-issued operation pin
scoped to the authenticated root coordinator, registered Location, Goal workspace and exact
operation/idempotency key. HostKernel resolves all paths and process arguments from trusted
state, evaluates the canonical Guard action (`git.worktree.acquire`, `git.worktree.list` for
inspection, or `git.worktree.release`), and routes admitted work through the existing one-use
EffectIntent/lease/receipt and confined ExecutionHost supervisor. Guard approval follows the
existing managed approval path. Since this approval is an interactive boundary, prepare and
execute are separate private operations: prepare persists the exact P8 intent/pin and returns a
Guard challenge; after explicit approval, execute consumes the one-use lease, persists the
possible-dispatch fence and invokes the fixed operation. A P8 intent append invalidates the
previous root proof, so HostKernel must derive a fresh root proof from current durable P8 state
before evaluating or executing Guard. No synchronous auto-approval or replay after UNKNOWN.
Release requires P8's clean pre-delete and post-delete MISSING
proof; uncertain outcomes remain UNKNOWN/quarantined. The private control request does not create
a second public capability or execution boundary. Core's direct worktree create/remove stays
unavailable.

## 17.24 Durable worker settlement and reconciliation proofs (2026-10-19)

P8 may append `worker_settled` / `worker_reconciled` only from opaque crate-private proof values minted by the authenticated P1 HostKernel after it re-reads both canonical owners. Do not expose the current `WorkerSettlement` or `ReconciliationProof` flag structs as a production caller API: booleans or caller-supplied evidence references do not prove process exit or effect settlement.

V1 managed `WorkerExecution` represents a logical Task child Session/Attempt in the existing Core process (`LOGICAL_CORE_SESSION`); it does not own a second worker PID and must never claim that the Core process exited. `WorkerSettlementProofV1` binds the exact P8 OwnerLog cursor, pool revision, worker state and reservation/worktree lease identity; the managed Goal/Run/Task/Attempt and DelegationBinding digest; P8 claim nonce; current authenticated root/Core owner epoch, process incarnation and peer identity; exact P2 OwnerLog terminal Attempt and complete effect-receipt evidence; and a typed settlement verdict. HostKernel additionally proves that the child prompt/callback scope is quiescent and that no Attempt-scoped Guard lease or owned command process remains active. Worktree reuse facts require current guarded workspace inspection. P8 rechecks its worker, lease, claim, cursor and revision before deriving internal transition fields and appending. SETTLED may release the logical ActiveWorkers reservation only after exact terminal Attempt and effect settlement plus the required quiescence proof; UNKNOWN or incomplete proof quarantines and retains conservative capacity. A future process-backed worker kind must separately bind and prove exit of its exact supervised process generation.

The coding Attempt remains live/EXECUTING through independent verification. Child prompt return records only `managed_dispatch_quiesced` while Task is PENDING_VERIFICATION; a separately guarded verifier intent/lease then runs under that same Attempt. After typed evidence is durable, P2 advances the Attempt to SETTLING and Task to Verified. P2 exposes a distinct typed settlement-candidate projection for this exact live SETTLING state; P8 uses it to pin the final guarded Inspect at the evidence revision. After Inspect has a durable Guard receipt, P2 settles the Attempt to Succeeded and exposes the terminal snapshot. P8 then settles the worker from that terminal snapshot plus the exact final Inspect receipt. The candidate and terminal projections are separate to avoid requiring a terminal Attempt before the Inspect needed for worker settlement. Worker capacity is never released before verifier evidence and final Inspect are durable. See §12.19.

Because the logical child shares Core's PID, process exit cannot establish prompt completion. After the exact managed `promptManaged` call returns, Core durably records its terminal outcome, then calls a private authenticated HostKernel completion operation for the consumed handoff. HostKernel checks the live authenticated Core peer, exact child Session/Attempt/handoff, absence of active Attempt callbacks, Guard leases and owned command processes, and mints a one-use `ManagedDispatchQuiescedProofV1`. ManagedControl appends the proof as `managed_dispatch_quiesced`; the terminal snapshot exposes its exact event cursor/digest. Only this persisted marker proves the managed prompt callback has returned. A crash or lost proof response after possible provider dispatch leaves the Attempt UNKNOWN and P8 capacity retained; exact completion retry may record/read the same marker but can never invoke the prompt again.

`WorkerReconciliationProofV1` binds the exact quarantined P8 logical worker/child Session, current owner epoch and authenticated Core peer, current P8 cursor/revision, managed Attempt/DelegationBinding and exact independent no-effect/terminal reconciliation evidence. P8 rechecks that the worker is still quarantined and all required terminal facts match before `worker_reconciled`; any stale, changed or ambiguous effect/workspace/callback fact remains quarantined. It cannot infer absence from timeout, process sampling, a closed Session, or a model's report. If a distinct process-backed worker is introduced later, reconciliation must also bind its exact process identity and verified exit.

The authenticated child Attempt Session and the root Run `SessionLink` are distinct identity domains. P8 admission/Attempt owner pins and the current managed owner use the child Session ID; root-coordinator registration pins use the root Session ID. Reconciliation must independently prove that the durable child prompt-quiescence record names that root Session as its parent. It must never compare or substitute the child and root Session IDs.

Both producer APIs are internal to the existing HostKernel→P8 path; this decision adds no public RPC or alternate scheduler. One-use proof digest plus exact delivery identity provides stable replay; a changed proof under the same delivery conflicts. A lost response is resolved from the durable P8 receipt before mutable cursor checks, while current authentication and the exact request/proof binding are still revalidated. This contract preserves §11.20's quarantine and release rules and does not claim unsupported OS resource quotas.

**Source status (2026-10-20):** P8 source now has a typed final-Inspect pin from the P2 `ManagedAttemptSettlementCandidateV1` (exact durable claim/binding, admission pins and verified Create registration). Its canonical idempotency key is `managed-final-inspect-{attemptID}`. The read-only restart accessor checks that key against the operation ID recomputed from the historical root owner, then revalidates same-lineage current root proof, claim receipt/pins/binding, worker/worktree state, candidate revision and exact clean/owned/no-follow receipt from replayed OwnerLog. It can return committed receipt evidence from a quarantined worker after restart but grants no settlement authority; cancellation, a process binding, UNKNOWN intent, stale lineage/revision or mismatched receipt remains unavailable. P8's opaque settlement consumer still requires the terminal P2 snapshot and exact Inspect receipt together; it persists final Inspect refs, final revision, bounded verifier artifact refs and settlement OwnerLog watermark, then derives `HostRunReceiptRefV1` only from committed receipt. Reconciliation rechecks the persisted Inspect operation/receipt against durable registration lineage and terminal revision. Source-level replay coverage was added but not run. P1 HostKernel prepare/execute and restart integration, P2 terminal-verifier/accounting integration, and P8 acceptance remain unverified; authenticated RC0 projection remains absent and RC0 is `NOT_ATTESTED`.

P8 source now also contains a distinct quarantine-only root reauthorization event/proof, exact retained-worktree target resolution, a fresh current-revision Guarded Inspect intent/dispatch/receipt path, and an idempotent resolver for an exact durable completed receipt after a lost execute response. P8 keeps root SessionLink identity separate from child Attempt Session identity and rejects nested ClaimedWorker lineage until its proof carries the Run root Session. P1 HostKernel integration is in progress; the receipt resolver cannot release leases, and failed/cancelled capacity remains quarantined pending a fresh full reconciliation proof. These source changes are unverified.

After P2 settles the Attempt, P8 also exposes a read-only terminal-snapshot resolver requiring Succeeded/Verified/AllSettled/Quiesced. A new typed P8 OwnerLog event binds the final Inspect operation to the canonical full SETTLING-candidate digest while retaining the candidate Attempt, SpecVersion, binding, evidence digest and final revision for exact terminal cross-check. Legacy Inspect records without this pin do not qualify for managed settlement. This source path is not yet tested or verified.

**Integrated sequencing contract (2026-10-20):** verifier evidence is committed before the P8 worker-settlement proof. The coding Attempt remains live through its separately Guarded verifier intent/lease; P2 records typed current-revision evidence, then HostKernel/P8 performs final guarded Inspect and settles from the exact terminal Attempt snapshot plus Inspect receipt. Final Inspect uses distinct prepare/challenge and execute/receipt operations so explicit TUI approval can occur between them. Every P8 append invalidates prior root proof; HostKernel refreshes it from the durable P8 state before continuing. Source wiring remains in progress and unverified.

**Workspace revision separation (2026-10-20):** managed admission keeps the authenticated parent-root workspace revision for root Session/Goal lineage and independently measures the selected child worktree workspace revision for `Attempt.workspaceRevision` and `DelegationBinding.sourceRevision`. P8's base-revision locator is a third independent value. No equality or substitution is valid among these facts. P8 source now persists the HostKernel-minted child Location/workspace/root/revision projection in the same durable DelegationBound transition, retains the original parent-root revision for registered worktree lease validation, and restores the child revision to the worker lease on replay. Historical attachment events without the child projection remain readable but cannot authorize modern managed dispatch or settlement. This source remains untested; final P1/P2 call-path integration and acceptance are still required before managed worktree admission/dispatch becomes available.

## 17.25 Managed provider request dual-digest binding (2026-10-21)

Before a managed provider request can dispatch, HostKernel authorization and durable settlement must bind both (1) the canonical normalized Horizon request digest, covering the selected provider/model and normalized prompt/tool payload in the live managed Attempt/owner epoch, and (2) the exact non-secret SDK transport request digest, covering the resolved destination/method and exact serialized request body/format emitted by the existing Core Provider adapter. Both pins are required on the same one-use authorization and settlement record; neither substitutes for the other. SecretBroker injects credentials only inside its trusted use callback; raw credentials and secret-bearing header values are never included in persisted digests. The provider adapter validates the concrete SDK destination against HostKernel's selected route revision before sending. Request rewrite, route/model revision drift, digest mismatch, stale Attempt/epoch, or lost/ambiguous post-dispatch result fails closed or becomes UNKNOWN; it never triggers hidden route fallback or replay. This prevents intent substitution and transport mutation while retaining the existing Core ProviderTransport and Rust Guard/ExecutionHost owners. No live dispatch is enabled by this decision; P1/P2/P6 wiring and later acceptance remain required.

The canonical Guard name is the sealed internal action `providers.infer`, recorded in the existing machine capability inventory as `kind: action`. It is not a model tool, ActionDescriptor, ToolRegistry entry, ToolBatch member, MCP method, plugin hook or alternative provider route. HostKernel alone mints it from a live authenticated ManagedRun Attempt and the selected route facts. It carries no arbitrary destination, credentials or fallback authority; the existing Core Provider/SecretBroker callback consumes the exact one-use permit before sending.

## 17.26 Direct provider authorization and context pinning (2026-10-22)

An authenticated user `prompt` or `continue` authorizes the requested direct model turn
under the provider, model, account, endpoint, and harness already selected in Core for that
Session, subject to the active privacy, network, token, and cost policy. Routine continuation
requests in that same turn do not require a new permission prompt. A route or policy change,
unknown required cost/privacy state, or a request that exceeds a configured limit stops before
dispatch and uses the owning settings/approval flow. A direct request never falls back to a
different provider, model, account, endpoint, or harness. This direct authorization is distinct
from managed `providers.infer`, which remains bound to a live managed Attempt and is never
reused as direct-session authority.

For every direct model request, Core `ContextService` compiles one bounded normalized provider
input. Core persists an immutable request pin and its digest before transport, and sends that
same in-memory normalized value; it must not recompile, mutate, or substitute a different body
after the pin. The pin binds the authenticated Session/request identity, current canonical
Session cursor, selected route tuple/revision, context source refs and revisions, provider-visible
tool projection, exact normalized provider-input digest, and applicable privacy/budget policy
digest. SessionStore/Core owns direct request identity, context and transcript persistence;
HostKernel/OwnerLog owns managed Attempt bindings. A post-dispatch crash or lost response is
UNKNOWN unless the provider offers an exact idempotency key and a trusted result can be
reconciled; it is never silently resent. The exact request, direct context, and provider policy
contracts and acceptance cases are owned by §§12–15, 30, 32 and 37.

The direct route projection is derived only by Core's existing selected-model/catalog resolver
from the exact selected ProviderV2/ModelV2 configuration, including the fixed adapter package,
adapter model ID, and normalized endpoint. Core gives the projection to the protected transport;
the transport independently resolves its concrete target from that same selected catalog entry
and must prove exact provider/model/harness/route/revision/endpoint-revision equality before
dispatch. `model.route.id`, request fields, environment credentials, caller metadata, and a
second OpenCode-only provider lookup are not route authority. The route revision covers the
non-secret adapter and selected catalog configuration; endpoint revision covers the normalized
fixed endpoint. If Core cannot produce the projection, or the transport cannot match it, the
direct request remains unavailable before bytes are sent. The HostKernel-authenticated
`DirectSessionPermissionModeV1.digest` is carried as `permissionScopeDigest`; Core's
privacy/budget-policy digest remains a separate `policyDigest`. Neither digest is a managed
Attempt scope or a per-effect grant, and neither bypasses Guard for tool effects.

## 17.27 CodeMode fixed-helper consent (2026-10-22)

The user explicitly enables `codemode.execute` for the current direct Session (or an exact
accepted managed profile) before it becomes model-visible. That choice may authorize the fixed
packaged `horizoncode:codemode:bun` helper launch on the current accepted backend, bound to the
exact `CodeModeResourceProfileV1` digest and Session/Attempt scope. This is a narrow capability
grant for one trusted packaged helper, not an arbitrary process or shell grant. Each invocation
still receives fresh Guard validation, durable intent, one-use lease, helper-process receipt and
settlement, but unchanged enablement does not trigger a repeated user prompt; nested tool effects continue through complete ToolBatch admission and their ordinary
Guard/lease/receipt path. Exact enablement is revoked or invalidated when the Session, profile,
runtime package, resource profile, owner epoch, policy or required containment changes. No
per-invocation dialog is needed inside that unchanged explicit scope. The UI must identify the
helper, limits and nested capabilities before enabling it. Without enablement, helper integrity,
or verified OS containment, the tool remains unavailable. This does not alter DEC-V1-28's
prohibition on arbitrary child-process grants. Owners and acceptance: §§12.21, 14.27, 16.10,
32.41, 33.21 and 37.24.

## 17.28 Default tool-surface policy (2026-10-22)

The default native-call harness uses `harness.native-rich` with a curated common coding surface
and filters every tool by current authorization, provider/model compatibility and availability.
It does not send the full capability catalog on every request. Long-tail capabilities use
progressive search/describe and become model-visible only at a safe request boundary. Users may
explicitly choose `harness.native-minimal` for small-context or lower-capability models; the
selected harness never changes provider/model or broadens authority. CodeMode follows
DEC-V1-29/17.27. Core preserves direct calls for simple operations. Catalog defaults and tool
discovery semantics are specified by §§16, 30, 32 and 33.

## 17.29 Direct-session artifact retrieval (2026-10-22)

V1 supports bounded search and range retrieval for artifacts produced by a direct Session's
Guarded tool/effect calls. The existing ArtifactStore remains the only canonical artifact-byte
owner; each direct artifact is bound to its Core Session, originating request/tool call, direct
effect receipt, content digest and immutable generation. Authenticated direct artifact reads are
limited to that Session and do not confer managed Evidence/Verification authority or access to
managed Attempt artifacts. A managed Attempt cannot resolve, read or cite direct refs/content;
equivalent bytes require an independently produced managed artifact with new owner-issued evidence
refs, and no cross-lane promotion/capture is allowed. Redaction, byte/node/range limits,
`full`/`head_tail_sample`/`failed` wire fidelity (shown as FULL/SAMPLE/FAILED in the UI), stale
generation rejection and restart-safe identity are required. No artifact is inferred from model
self-report or an unreceipted effect. The service, catalog, UI and acceptance contracts are owned
by §§12, 14, 16, 31–33, 37 and 45.

## 17.30 Web-search domain filters are query intent (2026-10-22)

`WebSearchRequestV1.domains` is a bounded query filter supplied as user/model intent. It does not
authorize destinations, change provider routing, or establish a domain security policy. HostKernel
validates canonical syntax/count/byte limits and exact equality with the authenticated Guard-approved
arguments. The fixed provider route and consent policy remain authoritative. V1 defines no separate
domain allowlist setting; adding one requires a future explicit policy owner and contract.

## 17.31 Direct-session Git inspection uses workspace read authority (2026-10-22)

The catalogued read-only Git operations are bounded workspace reads under the existing
`files.read` grant and Guard path, with authenticated principal, registered Location and
current workspace-revision pins. An exact pre-authorized workspace grant keeps ordinary
inspection prompt-free; when Guard returns ASK, use the normal UserAction approval flow.
The service accepts only finite structured operations (`git.status`, `git.diff`, `git.log`,
`git.show`, `git.branch.list`) with fixed argv templates, bounded output/time, validated
object IDs and repository-relative literal paths. It accepts no executable, cwd, environment,
raw argv, arbitrary subcommand, network operation or write operation from a caller/model.
Settled output is durably replayable under the exact same operation binding, either as bounded
receipt bytes or an immutable content-addressed artifact reference. Missing or conflicting
post-dispatch evidence remains UNKNOWN and is never relaunched. `repo.tree` stays under
RepoIntel and is not implemented as `git ls-tree`. This reuses the canonical capability and
Guard; it adds no second authority. See §§14.28, 20.15, 32.46 and 37.29.

## 17.32 Competitive research vs V1 adaptation law (2026-10-22)

Research comparing Windsurf, Cursor, OpenCode/mgrep, Aider, code-review-graph, Devin-style browser workers, and related MCP marketing is **non-normative evidence** unless distilled into §17, §10.18, §30.25, or §42.21 and backed by §32 acceptance. `DEC-V1-35` is the governing decision; `DEC-V1-34` defines how matched competitor benchmarks may be claimed. Implementation agents must not treat a research document, MCP README, or vendor “99% token reduction” figure as a scope expansion.
