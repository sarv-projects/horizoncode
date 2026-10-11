# HorizonCode — OpenCode-first universal software-agent architecture
**Architecture revision:** v2 integrated into existing `arch_V1/` · **Design status:** approved target to implement; not an integrated released runtime.

## Start here
The existing local code is derived from pinned OpenCode `b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322`. Existing `packages/` providers, Session runner, tools and UI should be reused. `kernel/` contains real Rust codecs/event-log primitives but not a complete supervisor or verification gate. Do not implement a parallel model-provider SDK or rewrite upstream Session management without a measured parity test.

**One authority per aggregate:** OpenCode owns the V1 canonical conversation Session/Input/Message/Part/provider continuation; Rust owns managed Goals/Specs/Runs/tasks/attempts, ToolBatch control metadata/correlation, effects, scoped approvals, resource/worktree leases, recovery and evidence. Rust OwnerLog is preserved for those Rust-owned aggregates; do not build a competing transcript store. Current implementation status belongs in `HANDOFF.md`, not this index.

**User-pinned models:** free/local and cheap models first-class; no cost-aware automatic routing and no unexpected switch to a paid provider. Permission modes ask/safe-auto/yolo-in-sandbox; tool effects always brokered.

## Read order
1. [Governance and decisions](17-GOVERNANCE-DECISIONS.md) + [existing code audit](24-LOCAL-CODE-AUDIT-AND-MIGRATION.md).
2. [Upstream OpenCode reuse](19-OPENCODE-UPSTREAM-REUSE.md) + [exact integration LLD](20-OPENCODE-INTEGRATION-LLD.md).
3. [System topology](01-SYSTEM.md), [domain](02-DOMAIN.md), [schemas and APIs](25-DATA-AND-CONTROL-PLANE-CROSSWALK.md), [IPC](13-COMPOSITION-IPC.md).
4. [Runtime](15-RUNTIME-EXECUTION.md), [recovery and worktree pooling](21-HEALING-PERMISSIONS-WORKTREE-POOL.md), [lifecycle](11-LIFECYCLE.md).
5. [UI](16-UX-SETTINGS-ECOSYSTEM.md), [builder experience](22-UNIVERSAL-UI-COMMANDS-MEMORY.md), [acceptance journeys](26-UX-ACCEPTANCE-AND-RELEASE.md).
6. [Competitive gap audit](28-COMPETITIVE-GAP-AUDIT.md), [agents/extensions](29-AGENTS-SKILLS-HOOKS-MCP.md), [context/index/local models](30-CONTEXT-INDEXING-LOCAL-MODELS.md), and [fast UI/artifacts/analytics](31-UI-PERFORMANCE-ARTIFACTS-ANALYTICS.md).
7. [Real-work task catalog](32-TASK-BASED-AGENT-TEST-CATALOG.md), [built-in capability catalog](33-BUILTIN-CAPABILITIES-CATALOG.md), [document audit ledger](34-DOCUMENT-LINE-AUDIT-LEDGER.md), and [user-request coverage matrix](35-USER-REQUEST-COVERAGE-MATRIX.md).
8. [Delivery](10-DELIVERY.md) and [adoption tests](23-ADOPTION-GATES-TESTS.md).

## Single-source-of-truth rule
The original 01–18 design contracts remain topic owners after their explicit reconciliation amendments. Conflicts are resolved first by adopted decisions in §17 and the 2026-10-11 resolutions in §§28–35, then by source-grounded integration chapters 19–27. Historical Rust-canonical transcript text is superseded by A-V2-11/§34 CR-01. Mark any new contradiction in §34 before coding. The uploaded comprehensive v2 source under `../docs/architecture-input/` is provenance only, not a competing architecture.

## Document index
| File | Responsibility |
|---|---|
| [01-SYSTEM.md](01-SYSTEM.md) | System topology and OpenCode/Rust process ownership |
| [02-DOMAIN.md](02-DOMAIN.md) | Canonical aggregates and stable identity model |
| [03-FLOWS.md](03-FLOWS.md) | Interactive, managed, visual, recovery flows |
| [04-STATE-EVENTS.md](04-STATE-EVENTS.md) | State/event/outbox/reconciliation semantics |
| [05-SECURITY.md](05-SECURITY.md) | Policy, isolation, threat boundaries |
| [06-CAPABILITIES.md](06-CAPABILITIES.md) | Upstream parity and implementation states |
| [07-UX-COMMANDS.md](07-UX-COMMANDS.md) | UI surfaces, action registry, slash commands |
| [08-RECONCILIATION.md](08-RECONCILIATION.md) | Historical versus adopted design decisions |
| [09-SOURCE-MAP.md](09-SOURCE-MAP.md) | Pinned repository path map and source audit |
| [10-DELIVERY.md](10-DELIVERY.md) | Phased delivery with acceptance gates |
| [11-LIFECYCLE.md](11-LIFECYCLE.md) | State machines, transition guards, terminal criteria |
| [12-DOMAIN-SCHEMAS.md](12-DOMAIN-SCHEMAS.md) | Domain/wire/versioned schema definitions |
| [13-COMPOSITION-IPC.md](13-COMPOSITION-IPC.md) | Service composition and private kernel transport |
| [14-EFFECTS-EXECUTION-SECURITY.md](14-EFFECTS-EXECUTION-SECURITY.md) | Effect authorization and sandbox/execution host |
| [15-RUNTIME-EXECUTION.md](15-RUNTIME-EXECUTION.md) | Context, provider turn, managed work and recovery |
| [16-UX-SETTINGS-ECOSYSTEM.md](16-UX-SETTINGS-ECOSYSTEM.md) | Settings, provider profiles, plugin UI and UX |
| [17-GOVERNANCE-DECISIONS.md](17-GOVERNANCE-DECISIONS.md) | Adopted ADRs, unresolved gates, normative priority |
| [18-OPERATIONS-RELEASE.md](18-OPERATIONS-RELEASE.md) | Storage, telemetry, packaging and release |
| [19-OPENCODE-UPSTREAM-REUSE.md](19-OPENCODE-UPSTREAM-REUSE.md) | v2 upstream ownership, reuse, licensing and extension seams |
| [20-OPENCODE-INTEGRATION-LLD.md](20-OPENCODE-INTEGRATION-LLD.md) | v2 integration packages/classes/functions and bridge |
| [21-HEALING-PERMISSIONS-WORKTREE-POOL.md](21-HEALING-PERMISSIONS-WORKTREE-POOL.md) | v2 recovery tiers, broker rules, worktree pool |
| [22-UNIVERSAL-UI-COMMANDS-MEMORY.md](22-UNIVERSAL-UI-COMMANDS-MEMORY.md) | v2 universal software-building UX, models, harnesses |
| [23-ADOPTION-GATES-TESTS.md](23-ADOPTION-GATES-TESTS.md) | v2 implementation stages, source-specific test gates |
| [24-LOCAL-CODE-AUDIT-AND-MIGRATION.md](24-LOCAL-CODE-AUDIT-AND-MIGRATION.md) | audited paths, existing implementation, exact change targets |
| [25-DATA-AND-CONTROL-PLANE-CROSSWALK.md](25-DATA-AND-CONTROL-PLANE-CROSSWALK.md) | v2 schemas, event ownership, control API and replay |
| [26-UX-ACCEPTANCE-AND-RELEASE.md](26-UX-ACCEPTANCE-AND-RELEASE.md) | reference UI, command list, end-to-end user acceptance |
| [27-IMPLEMENTATION-READINESS-AUDIT.md](27-IMPLEMENTATION-READINESS-AUDIT.md) | Coverage audit, contradicting decisions, implementation status and handoff truth |
| [28-COMPETITIVE-GAP-AUDIT.md](28-COMPETITIVE-GAP-AUDIT.md) | Codex/OpenCode/Cline/Claude/Grok Build comparison, evidence confidence and gap resolutions |
| [29-AGENTS-SKILLS-HOOKS-MCP.md](29-AGENTS-SKILLS-HOOKS-MCP.md) | rich agent profiles, specialists/subagents, skills, hooks, MCP and custom actions |
| [30-CONTEXT-INDEXING-LOCAL-MODELS.md](30-CONTEXT-INDEXING-LOCAL-MODELS.md) | typed context engineering, symbol indexing, local/small model runtime |
| [31-UI-PERFORMANCE-ARTIFACTS-ANALYTICS.md](31-UI-PERFORMANCE-ARTIFACTS-ANALYTICS.md) | streaming/UI performance, editor, artifacts/Mermaid, Mission Control, analytics, automations |
| [32-TASK-BASED-AGENT-TEST-CATALOG.md](32-TASK-BASED-AGENT-TEST-CATALOG.md) | model-independent real-work task and performance evaluation catalog |
| [33-BUILTIN-CAPABILITIES-CATALOG.md](33-BUILTIN-CAPABILITIES-CATALOG.md) | single catalog of built-in agents, tools, skills, jobs and renderers |
| [34-DOCUMENT-LINE-AUDIT-LEDGER.md](34-DOCUMENT-LINE-AUDIT-LEDGER.md) | line-audit scope, authority order, conflict resolutions and per-document actions |
| [35-USER-REQUEST-COVERAGE-MATRIX.md](35-USER-REQUEST-COVERAGE-MATRIX.md) | explicit mapping from requested capabilities/comparison sources to owners, deferments and remaining gates |
| [36-CONTRACT-CONVERGENCE-PLAN.md](36-CONTRACT-CONVERGENCE-PLAN.md) | C0–C7 architecture reconciliation plan and truth gates |
| [37-RUNTIME-SERVICE-LLD.md](37-RUNTIME-SERVICE-LLD.md) | concrete contracts for browser/LSP/delegation/automation/UI streaming/artifacts/cache |
| [38-OMP-SOURCE-COMPETITIVE-AUDIT.md](38-OMP-SOURCE-COMPETITIVE-AUDIT.md) | source-pinned OMP comparison, safety/license notes and proposed non-normative adoption candidates |
| [39-OMP-TUI-SLASH-MODEL-SETTINGS-AUDIT.md](39-OMP-TUI-SLASH-MODEL-SETTINGS-AUDIT.md) | 85 OMP slash definitions, 409 settings rows, role/provider UI, screenshot source comparison |
| [40-HORIZONCODE-OMP-INSPIRED-UI-PROPOSAL.md](40-HORIZONCODE-OMP-INSPIRED-UI-PROPOSAL.md) | non-normative Horizon typed UI/model/provider/settings/goal UX candidate and UAT |
| [41-OMP-STREAMING-VISUAL-ARTIFACTS-AUDIT.md](41-OMP-STREAMING-VISUAL-ARTIFACTS-AUDIT.md) | upstream TUI live SVG charts/Mermaid, terminal protocols, artifact store, livestream, source-backed gaps |
| [42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md](42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md) | 12 exact GitHub repositories/pins, 23 file-level source extraction candidates and mandatory reuse gates |
| [43-IMPLEMENTATION-SOURCE-LLD-PLAYBOOK.md](43-IMPLEMENTATION-SOURCE-LLD-PLAYBOOK.md) | exact local owner mapping, pseudocode, OMP extraction/adaptation sequence and verification |
| [44-FINAL-REPO-AUDIT-LEDGER.md](44-FINAL-REPO-AUDIT-LEDGER.md) | scanned file/line/link scope, contradictions, outstanding gaps and test truth |

## Machine-readable additions
- [Managed-work additive SQLite schema](contracts-v2/managed-work-additive.sql) — prototype migration, **not applied**.
- [Managed event envelope](contracts-v2/managed-event.schema.json) — example envelope slice; full event vocabulary remains in chapter 04.
- [Control-plane OpenAPI](contracts-v2/control-api.openapi.json) — additive run/goal route skeletons; does not replace OpenCode HTTP Session API.
- [AgentProfileV2 JSON Schema](contracts-v2/agent-profile-v2.schema.json) — rich agent/specialist profile contract with provider/model separate from explicit harness selection; design schema, runtime validation still required.
- [HarnessProfileV1 JSON Schema](contracts-v2/harness-profile-v1.schema.json) — prompt/tool/message/response shaping independent from provider/model choice.
- [PlanHandoffV1 JSON Schema](contracts-v2/plan-handoff-v1.schema.json) — structured Plan→Build scope/DAG/criteria handoff.
- [ContextLedgerV2 JSON Schema](contracts-v2/context-ledger-v2.schema.json) — typed model-visible context projection and epoch marker.
- [RuntimeObservationV1 JSON Schema](contracts-v2/runtime-observation-v1.schema.json) — measured/estimated/unknown analytics/runtime-stage observation.
- [Upstream source inventory](opencode-b1fe25ab-path-inventory.jsonl) — pinned historical source path counts, not code review.

## Completion standard
Source code copied, documentation authored, unit tests passing, or task-worker claims are not sufficient for feature acceptance. Every shipped feature needs explicit provenance, contract tests, isolated effects, final integrated-revision evidence, crash/replay checks where relevant, and a named UI acceptance path. Remaining prerequisites are recorded in [delivery gates](23-ADOPTION-GATES-TESTS.md) and [existing code audit](24-LOCAL-CODE-AUDIT-AND-MIGRATION.md).

## What this architecture update did not do
No production runtime rewrites, provider/session replacement, package deletion, git reset, auto-routing switch, worktree pruning or released user-visible feature implementation. Preserve the existing kernel/source and implement in bounded verified slices.

## Agent implementation handoff (2026-10-11)

Read [27-IMPLEMENTATION-READINESS-AUDIT.md](27-IMPLEMENTATION-READINESS-AUDIT.md), [34-DOCUMENT-LINE-AUDIT-LEDGER.md](34-DOCUMENT-LINE-AUDIT-LEDGER.md), and [35-USER-REQUEST-COVERAGE-MATRIX.md](35-USER-REQUEST-COVERAGE-MATRIX.md) before changing a system boundary. The canonical product docs skill is `packages/core/src/horizon/skills/horizon-docs/SKILL.md`; `.opencode/skills/horizon-docs/SKILL.md` is only a development compatibility shim. Use the skill for bounded retrieval rather than loading the entire corpus into each turn. Repo-root `AGENTS.md`, `HANDOFF.md` and `IMPLEMENTER_PROMPT.md` govern **how to execute** and identify the current implementation gate; they do not override product contracts. Do not copy implementation-status text from this index—`HANDOFF.md` is the bounded current checkpoint.

### Contract-convergence registry and schemas

- [Capability registry design seed](contracts-v2/capability-registry-v1.json) and [its schema](contracts-v2/capability-registry-v1.schema.json). Names are from §33; UNKNOWN effect class is not executable.
- [SkillManifestV2](contracts-v2/skill-manifest-v2.schema.json), [HookBindingV2](contracts-v2/hook-binding-v2.schema.json), [McpServerProfileV2](contracts-v2/mcp-server-profile-v2.schema.json), [AutomationV2](contracts-v2/automation-v2.schema.json).
- [UiStreamEventV2](contracts-v2/ui-stream-event-v2.schema.json), [BrowserActionV1](contracts-v2/browser-action-v1.schema.json), [LanguageServiceSnapshotV1](contracts-v2/language-service-snapshot-v1.schema.json), [SubagentDeliveryV1](contracts-v2/subagent-delivery-v1.schema.json).
- Offline validation: python3 scripts/architecture/validate_convergence.py. Parsing/fixtures do not verify TypeScript/Rust runtime services or platform support.

## Validation command for new contract convergence

Run python3 scripts/architecture/run_contract_tests.py to check schema/aliases, then the existing Bun/Core-to-Rust Session projection and Rust RPC tests. This is a narrow source-bound baseline, not evidence that the new service contracts are implemented. §36/§37 track missing runtime adapters.

### Pinned Oh My Pi research evidence (not implementation)
- [Source deep-dive](38-OMP-SOURCE-COMPETITIVE-AUDIT.md) at can1357/oh-my-pi commit eec114a9226da698ebc015fd8996a8ca3bc4625c; this is RESEARCH, not an adopted architecture mutation.
- [Full Markdown evidence inventory](omp-source-evidence-inventory.json) scans all 134 upstream Markdown documents and the local Horizon architecture corpus for line counts, headings, topical hits and checksums.
- [Native Rust module/API inventory](omp-native-rust-surface-inventory.json) structurally scans all 47 pi-natives module families, not a compiler-generated public ABI.
- [OMP 85 slash commands / 409 UI settings / semantic icons inventory](omp-tui-command-settings-inventory.json) — static declarations, not live controls.
- [OMP provider source roster](omp-provider-source-roster.json) — 20 pure web search, six grounded search, 92 catalog rule filenames; not usable-service counts.


### External source → implementation handoff (2026-10-11)

The operative coding-agent plan is [docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md](../docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md). Exact source links and legal/provenance gates: [§42](42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md) / [source JSON](external-source-register.json). Detailed component-level owner/pseudocode/testing: [§43](43-IMPLEMENTATION-SOURCE-LLD-PLAYBOOK.md). Per-file source/line audit: [mechanical manifest](repo-file-line-audit-manifest.json) and [§44](44-FINAL-REPO-AUDIT-LEDGER.md). Historical Rust canonical Thread cutover plans remain superseded. Runtime feature integration remains separately test-gated.

**Offline source provenance test:** python3 scripts/architecture/validate_external_sources.py (also included in scripts/architecture/run_contract_tests.py). It verifies source pins/URLs/owner fields and handoff links; it does not fetch or compile competitor code.
- [Local ignored reference clones inventory](ignored-reference-source-manifest.json) — scans repos/cline, repos/codex and repos/deepseek-harness separately; local commit provenance not established.
