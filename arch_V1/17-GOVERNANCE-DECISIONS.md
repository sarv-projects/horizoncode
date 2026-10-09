# 17. Architecture governance and reconciliation decisions

## 17.1 Adopted status and change control

**Decision: ADOPTED AND FROZEN AS THE V1 TARGET (2026-10-08).** The user directed that
`arch_V1/` be finalized and followed for the OpenCode-based HorizonCode v1 rebuild.
This freeze closes architecture design for implementation; it does not claim
implementation, verification, acceptance or release readiness. The top-level
[`README.md`](README.md) is the status and index authority. Changes use §17.5; open
capability-specific decisions below remain gates only for their named capability.

For new v1 work, this package governs architecture, behavior, schemas, flows, UI,
commands, tools, permissions, recovery, persistence, and implementation ownership.
After architecture freeze, the intended active main line starts from the exact pinned
OpenCode commit. The prior HorizonCode repository was initially preserved on
`legacy-horizoncode` and at `pre-opencode-rebase`. On 2026-10-08, the user later directed
removal of all prior Git metadata before initializing a fresh repository; those local
refs and objects are gone. This leaves the P0 archive/provenance gate incomplete and
does not make historical source available for porting. No old crate is ported merely
because it exists. Porting requires independently recovering and verifying source, an
explicit mapping to a final v1 owner/interface, a reuse/adapt/extract/drop decision,
and tests for the selected behavior.

The target cutover main contains the pinned OpenCode base, finalized `arch_V1/`, and
current root guidance aligned with that tree. The fresh repository currently has no
commit; OpenCode source files and root guidance remain local but ignored, so the target
cutover is not yet established. The repository does not carry old `ARCH/`, proposal
dumps (`info.txt`/`info2.txt`), research dumps, or a `legacy/` source subtree. Any
recovered historical materials remain non-normative; implementation decisions must be
self-contained in `arch_V1/`. OpenCode is retained substantially intact until
compatibility evidence proves a path unreachable or superseded; Horizon behavior is
added at narrow seams and dead code is removed only after that proof.

Architecture freeze does not claim implementation, security, platform capability,
verification, acceptance, or release readiness. It does not change existing `TODO.md`
statuses or acceptance evidence. Subsequent material architecture changes must update
this decision record and every affected `arch_V1/` contract, schema/event/API, gate, and
source map together. Unresolved DEC-V1 items block only their explicitly listed
capabilities and claims, not unrelated implementation phases.

## 17.2 Normative authority and evidence law

`arch_V1/` is the self-contained normative source for implementation. `info.txt`,
`info2.txt`, historical `ARCH/`, conversation records and research material document
provenance only; they are not required reading for implementing a v1 contract and
cannot override this package. Their useful requirements and decisions have been
reconciled here. A future requirement/change becomes normative only after it is
explicitly adopted and recorded in `arch_V1/`.

When authoring/revising this architecture, explicit user direction controls product
choices; exact local/upstream source and tests establish only bounded implementation
facts, not normative behavior. For implementation research use the evidence order below.

Within implementation research, exact local source > git history > pinned upstream
source > official documentation > secondary explanation. A design or source
description never proves that behavior is implemented, secure, performant or
accepted. Tests prove only their tested subject and environment. Mocks, static
catalog rows and schemas do not establish platform capability.

## 17.3 Adopted v1 decisions

The following are normative v1 decisions captured by the adopted architecture. Their
implementation and acceptance remain subject to the dependency-ordered gates in §10:

| Area | Adopted v1 decision | Resolution and explicit limit |
|---|---|---|
| Product base | OpenCode-derived repository tree is the main host/application and package base | User direction; not merely an optional compatibility sidecar |
| Repository cutover | Target: preserve prior HorizonCode at branch `legacy-horizoncode` and tag `pre-opencode-rebase`; create new `main` directly from the selected OpenCode commit, without requiring a GitHub fork | Original user direction; later fresh-Git reset removed local archive refs and initialized an empty `main`, so this P0 decision is not fulfilled. Recover source/provenance independently or explicitly revise the gate; old components require a reviewed migration matrix before selective port |
| Upstream synchronization | Pin every build/release; no automatic merges. Review upstream at each planned Horizon release and expedite security-fix review | Product/release policy; each Horizon patch has a named module owner and disposition in a patch ledger; release integration owner approves candidate SHA and compatibility evidence |
| Generated upstream files | Regenerate only with the pinned generator/toolchain and lockfiles; commit generated outputs when the upstream build expects them; never hand-edit generated output | Deterministic generated-client/parity check is required before updating a pin; generated artifacts are not a second source of truth |
| Upstream divergence budget | No numeric LOC/percentage cap; zero unowned or unclassified divergence is allowed | Every Horizon patch is narrow, owned, tested and classified; re-review the complete patch ledger at every upstream candidate. Retain OpenCode code until proven unreachable/superseded; no broad preemptive carve-down or blind wholesale merge |
| TUI/web/desktop | Retain OpenTUI/Solid, OpenCode Solid app and Electron shell | Adopted v1 surface; historical alternatives are provenance only |
| Host loop | OpenCode Core V2 is the sole production Turn runner | P0 establishes and verifies the pinned OpenCode base; production route convergence follows canonical Thread and whole-batch/Guard gates; legacy `packages/opencode` is migration/compatibility, not an alternate runner |
| Provider transport | OpenCode `packages/llm` is primary provider/protocol implementation | Pricing/capability metadata is advisory; route selection is explicit |
| Canonical conversation | Rust ThreadService owns canonical Thread/input/Turn/message history | OpenCode SQL Session DB becomes migration/test/rebuildable projection only |
| ToolBatch ownership | ThreadService owns and commits every ToolBatch transition and ordered result in the Thread stream; ToolExecutionCoordinator executes and returns observations only | No second ToolService event store or executor-owned ToolBatch transition |
| Managed execution | Rust RunController owns Goal/Spec/Run/Task/Attempt/WorkerExecution truth | Thread/Session idle, process exit and worker message do not mean Task PASS |
| Kernel seam | Supervised Rust process over private local, versioned IPC | No FFI into Bun, no public kernel listener and no second orchestration engine |
| Private encoding | Length-prefixed, bounded MessagePack `HzKernelRpcV1` | Normative private channel; historical alternative encodings are not mixed into it. Public app API remains separately generated OpenCode HTTP/API |
| Service composition | Effect services plus Horizon manifest/resolver/runtime | One Service Definition → Provider → Consumer model; do not add Cordis/second effect framework |
| Sealed services | Canonical security/execution owners fixed in production | Plugin architecture is not authority replacement; test adapters remain possible |
| Extensions | Third-party executable code isolated or capability-limited | OpenCode in-process arbitrary server-plugin trust is not adopted |
| Direct/managed | Direct Turns are lightweight; Managed Runs are explicit/reviewed | Avoid mandatory Goal/Task ceremony for ordinary pair coding |
| Tool batch | Assemble/validate the whole provider response before executing calls | Required OpenCode integration adaptation; inspected Core V2 dispatches calls as stream events arrive |
| Hosted tools | Provider-executed tools unavailable in governed v1 without pre-execution mediation | `providerExecuted` cannot be protected by a later local Guard call |
| Context | Keep ContextEpoch and plugin-contributed sources; one ContextService | DCP is retained as deterministic pruning policy inside that owner, not a separate engine/store |
| Profiles | One AgentProfile registry for main/default/specialist/custom/native/external | Profile revisions are pinned; no second subagent lifecycle/catalog |
| Model selection | Explicit → fixed selected profile/default-subagent → valid parent inheritance → main default → peer-managed only when the external peer owns selection | `inherit_parent` requires a parent with a resolved fixed route and an adapter able to apply it; root selection cannot inherit. No price, latency, subscription or “cheap capable” automatic selection; no silent reasoning downgrade |
| Effects | Canonical action/resource resolution and budget → Guard/approval → durable PREPARED → one-use lease/execution → target observation → settlement/UNKNOWN | `managed_run` covers integration without an Attempt; user-started operations use `user_action`, autonomous maintenance/update uses `system_operation`. Origins do not grant authority or bypass Guard; no claim of exactly-once without real target idempotency |
| Usage and budget | UsageService owns append-only usage observations; BudgetService owns limits, reservations, and accounting settlement; Analytics is derived | Usage provenance stays explicit; settlement references observations and never duplicates them |
| Completion | Only current verifier Evidence accepted by RunController produces Task PASS | A check receipt or worker self-report is evidence material only |
| Repository/memory | Horizon-owned derived repository generations and advisory provenance-bearing memory | One index system for main/children; neither grants Guard or changes spec |
| Memory supersession ordering | `MemoryRecordV1.supersedesMemoryIds` uses strictly ascending lexicographic order of stored UTF-8 bytes | User explicitly selected this v1 comparator on 2026-10-09. Schema validates accepted records without sorting/normalizing; MemoryService still derives the accepted set and revalidates sources atomically |
| Process execution | One ExecutionHost supervises all local child processes | No independent subprocess manager for shell, MCP, LSP, plugin, agent or index helper |
| ExecutionHost placement | Rust module inside the supervised `hz-kernel` process | It is distinct from the Bun/TypeScript `hzcode` host; the OS sandbox/process backend is below it |
| First release platform | Windows is the first release target | WSL may be an execution backend, never the Windows storage root. Target priority is not evidence that sandbox support exists |

DEC-V1-10 is resolved by the user's repository strategy and the cutover/synchronization
rules above (2026-10-08). It no longer blocks repository bootstrap. This resolution does
not execute the Git archive/cutover or imply that later release-specific decisions are
resolved.

### Historical provider/context alternatives

Historical proposal revisions contained contradictory provider/context alternatives.
The frozen v1 result is fully specified in §§01, 12, 13 and 15: OpenCode Core V2 with
`packages/llm` is the host/provider base and one ContextService owns context policy.
Proposal snapshots are not consulted to implement those contracts. A future measured
Rust provider adapter may exist only for a concrete protocol/performance requirement,
behind the same route contract, and requires a separate measured architecture change.

The OpenCode repository pin used for source observations is
`b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322`, not the older OpenCode SHA cited in
either input. Where the pinned code differs from the adopted architecture, the
difference is an adaptation/gap, not assumed existing behavior.

## 17.4 Unresolved decisions and capability-specific gates

These decisions remain unresolved. Each gates only the implementation capability,
platform release, or product claim named in the **Must resolve before** column. Other
work may proceed when its dependencies and safety boundaries are satisfied. The safe
interim behavior remains mandatory while a gate is unresolved.

| ID | Decision still required | Owner/evidence needed | Must resolve before | Safe interim behavior |
|---|---|---|---|---|
| DEC-V1-01 | Windows sandbox backend and exact enforced filesystem/process/network dimensions | Security + Windows systems; adversarial acceptance on supported Windows versions | Confined effects and Windows P3 production acceptance | Confined capabilities unavailable; only separately disclosed `full-access` posture, never marketed as sandboxed |
| DEC-V1-02 | macOS release support tier and supported Seatbelt/App Sandbox packaging path | Release/security; signed native build acceptance and child/network tests | macOS release | Show current `best_effort` network residual; refuse requirements for enforced network containment |
| DEC-V1-03 | Linux supported distributions, bubblewrap/kernel prerequisites and guarantee matrix | Platform owner; clean-machine acceptance per baseline | Linux release | Capability detection with fail-closed refusal for required guarantees |
| DEC-V1-04 | Third-party plugin signing roots, publisher identity, marketplace sources, revocation and rollback | Security/release governance and threat review | Third-party executable plugins and P8 ecosystem release | No third-party executable activation; first-party shipped providers only |
| DEC-V1-05 | WASM runtime choice, syscall/import set and escape/resource testing | Runtime/security evaluation on target platforms | WASM extensions and P8 ecosystem release | WASM plugin class unavailable until independently accepted |
| DEC-V1-06 | SecretBroker transport: brokered request proxy versus tightly scoped host byte delivery per provider protocol | Security/provider implementation review and provider matrix | Real authenticated provider integration and P3 provider release path | Provider auth is unavailable unless its exact delivery path is brokered and verified; no third-party plugin/child access |
| DEC-V1-07 | Managed confirmation/approval posture per action class and risk | Product + security policy owner | P6 Managed Runs | Explicit user approval of exact review digest before Run activation; Guard still decides every effect |
| DEC-V1-08 | Required verifier independence by risk tier (same provider/model allowed or not) | Acceptance/security owner; empirical correlated-failure analysis | P7 independent verification | Distinct execution, read-only view and no producer write rights; label same-model independence as procedural only |
| DEC-V1-09 | Retention durations, deletion/crypto-erasure, backup and legal hold by data class | Privacy/legal/security owner | Privacy/release gate before retention or deletion claims | Preserve source with explicit retention metadata; no numeric retention or physical-erasure claim |
| DEC-V1-11 | License, attribution, notices and redistribution obligations for OpenCode-derived code and bundled assets | Release/legal review against exact pinned tree/artifacts | Distribution of the derived product or bundled assets | Do not distribute until obligations are identified and notices packaged; reading source is not a redistribution clearance |
| DEC-V1-12 | App signing, update metadata root, channels, staged rollout, rollback health checks | Release/security owner; signed update drill | P9 automatic updates | Updates disabled or manual verified distribution; no active-binary activation or live schema mutation while unresolved effects/workers own mutable state; download/staging/read-only inspection allowed, fenced UNKNOWN is no exception |
| DEC-V1-13 | LiteSPM versus native package installer ownership by package/scope | Product/integration owners | P8 package ecosystem | One installer owner per package; no concurrent management of same install root |
| DEC-V1-14 | Remote continuation, cloud execution, user identity and data residency | Product/security/privacy | Post-local remote continuation | Local-only v1; no remote authority or cloud continuation assumption |
| DEC-V1-15 | Exact accepted MCP protocol versions/transports and remote-auth profile | Protocol owner, pinned SDK/spec and conformance tests | MCP integration and P8 ecosystem release | Pin SDK/spec at implementation; reject incompatible protocol/auth features |
| DEC-V1-16 | OS credential store/key derivation and state-root encryption per platform | Security/platform owner; recovery and account-transition tests | Authenticated provider release path | Store references only; refuse protected storage features not available on target |
| DEC-V1-17 | Windows `run_durable` event-store synchronization backend for long-horizon Runs | Storage/platform owner; Windows filesystem crash/power-loss tests, directory-entry durability and recovery evidence | P2 Windows durable owner-stream persistence and P6 Windows durable Managed Runs | Current `horizoncode-eventlog::StdCommitSink` reports `run_durable` unavailable off Unix; durable Windows streams/managed Runs remain unavailable until a backend is implemented and accepted |

This register is not permission to choose unresolved decisions silently. Each decision
moves to `resolved` only with decision owner, alternatives, rationale, date/revision,
affected contracts and evidence/acceptance record. Until then, gate only the affected
capability or claim and continue unrelated work without weakening its dependencies.

## 17.5 Contradiction and change procedure

When a required behavior conflicts across inputs or source:

1. Quote/link the conflicting sections and identify whether the conflict is design,
   implementation or acceptance evidence.
2. Check the latest explicit user direction and source pin; do not count repeated
   text as consensus.
3. If this package already records a resolution, confirm the exact rationale and
   affected contracts remain consistent.
4. If resolution requires a product/security/platform choice, mark the affected
   capability `unavailable`, record an open DEC-V1 item, and stop that implementation
   path pending owner decision.
5. For an approved architecture change, update this decision record, governing
   contracts, schemas/events/API/error tests, delivery gates and source map together.

Updating `arch_V1/` does not auto-update implementation status, TODO, tests, acceptance
records or release readiness. Migration from historical `ARCH/` contracts and current
implementation must preserve a traceable old-to-new owner/contract mapping and must
never leave two writable owners.
