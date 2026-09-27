# CURRENT_RUN — HorizonCode

Updated 2026-09-27. This handoff is for the ongoing architecture audit and documentation consolidation.

## Goal and confirmed direction

Build HorizonCode as an autonomous software-engineering agent for high-level coding tasks: understand unfamiliar repositories, plan/implement/debug, test independently, support review/PR workflows, and persist correct progress through multi-hour work.

The first architecture outcome is **verified completion of multi-hour coding tasks**. Cost, latency and integration breadth matter, but cannot silently weaken intent alignment, effect safety or final verification. Existing single-binary and terminal-first assumptions may change if evidence supports that.

The runtime may run on a user-selected laptop/workstation or a user-managed server. No HorizonCode-operated cloud control plane is required. The user clarified that SSH is for Git; remote UI attachment, remote administration and multi-user hosted tenancy are outside current scope. Same-host local detach/attach is a separate proposed capability.

## Source baseline and implementation status

- Inspected source baseline: Git 53a2654 on local main, 2026-09-27.
- Rust source was unchanged from 1c7a1c6. This audit changed architecture/research/ledger documentation only; no Rust implementation was changed.
- Eleven HorizonCode crates exist. Audit and analytics implementations are present; their existence does not mean all desired guarantees work.
- The proposed durable task DAG/controller, independent task verifier, effect reconciliation, hierarchical budgets, agent registry/client adapters, TUI/settings and multi-hour acceptance gates are **not implemented** unless a specific row in TODO states otherwise.
- No tests, builds, benchmarks or platform acceptance runs were executed during this audit. Historical test summaries in older handoffs do not apply as verification evidence for 53a2654.

## Work completed

1. Read all 28 Markdown files now present in ARCH, the current TODO/handoff/research notes, and relevant Rust execution, CLI, session-store and audit paths. ARCH/24 records evidence-based design/source findings and separates facts, design gaps and inference.
2. Audited the long-horizon controller, specification/intent workflow, task/attempt/evidence schema, recovery, stop policy, budget reservations, peer tracking, integration/PR lifecycle, provider/local inference, terminal UI, settings, slash commands and @ references.
3. Rechecked source maps for Cline, Codex, OpenCode and DeepSeek-Reasonix, and reviewed MiMo-Code as an OpenCode fork. Research notes are focused audits of selected high-value public source paths, not claims that every line of these large codebases was read. Claude Code implementation is not public.
4. Found and documented source issues including audit CLI reads mutating the inspected chain, malformed/missing audit head ambiguity, directory enumeration errors appearing empty, and process-local rather than cross-process audit locking. See F-44 and F-47..F-50, REQ-AUDIT-009..011 and AX-346. The architecture cross-check also found and repaired the proposed goal-clear lifecycle and draft/prepare/activation gaps as F-51..F-53 / DEC-047..049.
5. Found F-54: the design did not establish an authenticated, non-forgeable operator principal separate from model-controlled children; tool todo writes had an overly broad session-state label; current Windows source permits bare full-access. Updated REQ-SEC-026, sandbox/profile rules, principal and approval schemas, ACP role direction/trust contract, progress-event schema, threat table, G-14 and process-level test requirements. These are proposed safeguards; no backend acceptance or implementation is claimed.
6. Found F-55: the proposed `RunController::approve_spec` accepted caller-supplied `UserActor`, while the mutation guard contained only fencing data and goal lifecycle methods were absent from the typed controller interface. Replaced that with opaque, controller-minted `MutationContext`, operation-scope authorization and explicit typed goal methods/errors; added forged-context acceptance cases. This remains proposed, unimplemented design.
7. Rechecked ACP against official v1 protocol and elicitation RFD pages on 2026-09-27: elicitation is agent-to-client, requires explicit capability negotiation, and connection/session binding is not user authentication. The RFD records completion/stabilization on 2026-07-22. Updated mutable-source links and specified that only an authenticated trusted interactive connector can approve; a peer elicitation cannot.
8. Updated audit schema/flow and acceptance criteria, clarified same-host attach semantics, aligned status vocabularies, removed duplicate F-46 and O-08 entries, and added the September 2026 test/benchmark plan.
9. Rebuilt TODO as a source-baselined inventory for AX-001..010, AX-101..126, AX-201..208, AX-301..306, AX-307..333, and AX-334..347. Each row links to its owning architecture doc and states the next evidence/gap.
10. Consolidated external research under research docs. Root Markdown entry points are AGENTS.md, CURRENT_RUN.md and TODO.md; architecture stays in ARCH/.
11. Found F-56 in a final approval/schema/crash-path audit: a digest-bound receipt alone did not persist which review bundle was shown to which authenticated control session, how concurrent/stale previews are invalidated, or how replay is handled. The previous activation prose also implied cross-store atomicity across event log, SQLite projection, budget ledger and process launch, without an outbox schema. Added `GoalApprovalChallenge`, its idempotency/invalidation contract, durable reservation→`GoalActivated` commit ordering, `DispatchOutbox`, ACC-H1-07, and race/crash tests. This is proposed design only; no controller implementation or acceptance test ran.
12. Found F-57 in the cancellation path: `/cancel` and its receipt advertised run/task/attempt targets while the typed controller only exposed run cancellation, and natural-language control state did not persist a typed target. Added target-scoped API/schema, principal/scope authorization, idempotent `CancelRequest`, exact run/task/attempt fence semantics, dependency blocking without cascade, retry rules, and `RECONCILING` for unknown effects; added DEC-052, REQ-HORIZON-025, ACC-H1-08, and AX-347. This is proposed design only; no controller implementation or acceptance test ran.
13. Added the shared `CMP-artifact` HLD/LLD and aligned session/run ownership, object refs, pins, GC, settings, UI placeholders, migration, evidence gating, and tests. Added F-58 (payloads could make replay/session save unbounded), DEC-053, REQ-SESS-005/REQ-HORIZON-026, ACC-P1-09/ACC-H1-09, AX-348. This remains design only.
14. Added F-59 for unsafe provider output-truncation recovery, using Cline v4.1.21 as route-specific peer evidence; added typed finish cause/partial attempt, a one-shot retry fence, UI state and route conformance requirements (DEC-054, REQ-CTX-011, ACC-P1-10, AX-349). No route or recovery behavior is implemented or verified.
15. A second storage pass found F-61: the current session store uses one unbounded JSONL file, reads the whole file into memory, and has no event-log byte ceiling. Added bounded segments, digest chain/head, streaming replay, separate event quotas, emergency control reserve and crash-durable run profile (DEC-055, REQ-SESS-006, REQ-HORIZON-027, ACC-P1-11, ACC-H1-10, AX-350). No source migration or stress test has run.
16. The same source trace found F-62: `read_only` reaches a parser that truncates an incomplete final line; `list` reaches `load`, which can append repair events. Separated read-only access from explicit effect-reconciling recovery (DEC-056, ACC-P1-06/12, AX-351). This is a verified control-flow finding by inspection; it has not been reproduced by execution, and source code remains unchanged.
17. Refreshed verification traceability to 13 P1 records and 10 multi-hour acceptance scenarios; updated the research test plan, core-agent crosswalk and TODO ranges. All acceptance criteria remain proposed and have no current evidence records.
18. Found F-63: session creation uses `File::sync_data` without syncing the containing directory; its crash-durability guarantee is platform-dependent. Read the current Rust, Linux, SQLite and Windows primary docs; specified file/head/namespace sync acceptance and refusing unsupported profiles (DEC-057, ACC-P1-13, AX-352). No platform/power-loss test ran.
19. Found F-64: `SessionStore::list` returns empty on directory failure, flattens iterator errors, and drops sessions whose load fails. Added typed `SessionListResult`, explicit incomplete-enumeration states and visible unavailable entries, tied into read-only acceptance and UI (REQ-SESS-006, ACC-P1-12, AX-353). No fault injection ran.
20. Cross-document update now carries 13 P1 acceptance rows and 10 long-horizon scenarios. Their criteria are plans only; there are no corresponding acceptance evidence files.

## Research currency and limits

The research snapshot is dated 2026-09-27. September 2026 references, local inference options and benchmark methodology are recorded in research docs/research-landscape.md and research docs/tests.md, with direct primary-source links. Terminal-Bench 4.0 and SWE-Bench Pro V2 are planned evaluation inputs, not completed benchmark runs or claims of superiority. ACP v1 and its completed elicitation RFD were checked against the official protocol pages on that date; implementation schemas must still pin a released commit/version.

External projects are studied for patterns and failure cases; no upstream source code was copied in this documentation audit. Any future code adaptation must follow ARCH/05 provenance and license rules.

## Current architecture owners

- ARCH/00–05: document authority, vision, requirements, HLD, decisions and source/license ledger.
- ARCH/06–23: UI, sessions, loop, repository context, tools/providers, guard/sandbox/audit/protocols/orchestration/config/compression/analytics/discovery/security/verification.
- ARCH/24: dated review findings and source evidence.
- ARCH/25: integrated long-horizon HLD/LLD, schemas, lifecycle, recovery, budgets, execution plan, PR delivery and observability.
- ARCH/26: crosswalk from coding-agent patterns into owned design/gaps.
- ARCH/27: commands, @ namespaces, agent directory, subagents, quota visibility, settings, themes, notifications and permission controls.
- research docs/tests.md: test layers, edge cases, local inference matrix and benchmark protocol.
- TODO.md: task source status/dependencies/owners.
- AGENTS.md: instructions for any coding agent working in this repository.

## Worktree preservation

The user-owned untracked uipics/ screenshots are preserved and must not be staged. No source implementation changes are present from this audit. A local code-intelligence index attempt failed inside its installed helper before producing a usable index; its generated cache is not a project deliverable and must not be committed.

## Audit closeout

- The focused cross-document consistency review through F-64 is complete across requirements, decisions, HLD/LLD, schemas, APIs, UI, settings, verification, tests plan, and TODO ownership links.
- Document-only validation passed: `git diff --check`; 56 active Markdown files checked with zero broken local links; root Markdown inventory is exactly `AGENTS.md`, `CURRENT_RUN.md`, and `TODO.md`.
- Historical `archives/` files were excluded from active-link validation; they retain old references to retired ADR paths. They were not changed as part of the current architecture set.
- No Rust/source changes, tests, builds, benchmarks, fault-injection, or platform acceptance runs occurred. All new acceptance criteria remain proposed evidence requirements, not achieved results.
- Commit the intended architecture/research/handoff documents as requested. Preserve untracked `uipics/` and `.code-intelligence/`; do not push or alter remotes.

## Next implementation work

Begin with the highest-risk proposed storage migration: bounded segmented event logs, explicit non-mutating read paths and recovery, crash-durable commits, and typed session enumeration (`AX-350..353`). Implement and verify these in dependency order against `ACC-P1-06` and `ACC-P1-11..13`, then continue the remaining proposed TODO tasks. Do not treat this audit or its design documents as implementation evidence.
