# 36 — Architecture and contract convergence implementation plan

**Date:** 2026-10-11. **Status:** normative reconciliation plan, not feature acceptance.
**Basis:** adopted §17 A-V2-11–20, §25 two-store crosswalk, §35 coverage, inspected local source paths. No provider/runtime/GUI change is authorized by this plan.

## C0: Freeze ownership boundary
- OpenCode Core V2 owns Session/Input/Message/Part/provider continuation, model transport and conversational tool-call/result parts. Rust MUST NOT recreate their content in a canonical Thread store.
- Rust OwnerLog/control owns Goal/Spec/Run/Task/Attempt, ToolBatch control admission/correlation, Guard/EffectIntent/lease/ExecutionHost, resource fencing, recovery, verifier decisions and evidence.
- UI, indexd, plugin/MCP must not become aggregate owners. Cross boundary with bounded versioned refs/events, not canonical transcript copies.
- Direct interactive Session needs no Goal/DAG but always requires Guard for effectful operations. Managed runs attach durable goal/task via the bridge.
- Superseded Thread/Tauri excerpts go to docs/architecture-input/2026-10-11-superseded-contract-excerpts.md (provenance only).

## C1: Converge real sources
- §37 maps every proposed service/function to VERIFIED EXISTING SOURCE or PROPOSED PLACEMENT (NOT IMPLEMENTED). Do not invent crates/packages.
- No duplicate providers, canonical conversation database, independent subprocess supervisor, or desktop shell. Preserve pinned OpenCode snapshot.
- Core has whole-response ToolBatch preflight, but Bun still dispatches tools: Rust Guard/ExecutionHost P1.3 remains open.
- P1.2 Session observer/supervisor remains the active implementation gate; this work changes only docs, contracts and non-effect test fixtures.

## C2: Unify registries
- One governed ID namespace for agents, jobs, skills, tools, ActionDescriptors. No user/project alias can shadow a sealed builtin.
- contracts-v2/capability-registry-v1.json is a design seed, NOT the runtime-built capability inventory.
- §33 tool IDs are canonical; old fs.*, exec.*, agent.* and repo.symbol spellings are compatibility aliases resolving through the SAME registry, Guard and effect class.
- Pin registry, schemas, profile, model, harness and toolset generations per provider turn. Unknown/ambiguous alias fails closed.

## C3: Close service LLD
- §37 defines inputs, outputs, auth, idempotency, cancellation, replay/backpressure, errors and tests for browser/DOM, LSP broker, delegation mailbox, automation, UI event mux, artifact render and cache adapters.
- External tools and retrieved content cannot grant authority.
- Mermaid terminal path: capability probe, isolated renderer, validated image protocol if available, otherwise ASCII/source; do not assume universal terminal image support.
- Provider cache stats: reported means measured, estimation labeled, absent means unknown.

## C4: Contracts and cross-language testing
- New JSON Schemas for skills, hooks, MCP, automations, UI streams, browser actions, LSP snapshots, delegated message envelopes.
- Validate schemas, positive/negative fixtures, alias uniqueness/target IDs, existing source paths.
- Prior to wiring runtime, generate TS/Rust bindings from a single accepted schema contract and run actual TS and Rust boundary tests against identical fixtures. Parse-only checks DO NOT count as TS/Rust conformity.

## C5–C7: Performance, acceptance, handoff
- Stage spans: IPC, Guard, context compiler, index, rendering, stream, cache reporting. §31 percentiles are engineering targets, not existing measurements.
- Extend §32 test catalog and §35 coverage matrix; cover hostile aliases, replay, stale handles, scheduled overlap, Mermaid crashes, weak model prompts.
- Freeze implementation of affected new service only when its schema/owner/error/test is unresolved. Continue unrelated P1.2 normally.
- Preserve dirty/untracked user files. No reset, cleanup, commit or push by default.

## Acceptance
1. Operative owner/process/flow tables agree with §17 and §25; superseded bodies kept as provenance.
2. Existing versus proposed locations explicitly labeled and correct.
3. Registry and schemas parse; focused contract fixtures pass.
4. Every new LLD service has authority/lifecycle/error/test.
5. §§10,23,32–35, AGENTS, HANDOFF and README point to reconciled contracts.
6. Markdown structure, Git whitespace and regression tests have logged status; schema success is NOT application acceptance.

**Sequence:** C0→C1→C2→C3→C4→C5→C6→C7. Resume active P1.2-B, then P1.3. P10 identity migration and autonomous self-improvement stay post-V1.

## C4 runnable source-bound baseline (2026-10-11)

Run python3 scripts/architecture/run_contract_tests.py for design-schema validation followed by the **existing, real** Bun Session-to-Rust projection and Rust authenticated RPC tests. Last manual source-bound tests on 2026-10-11: 5 Bun tests, 52 assertions, pass; 2 Rust tests, pass. Those tests do not validate the newly proposed Browser/LSP/Delegation/Automation/Mermaid/Cache services. Add generated TS/Rust binding validation, shared malformed/cross-process fixtures, security/timeout/replay tests before any new service is WIRED/VERIFIED.

## C8 — Source-pinned extraction, adopted UI and visual output gates (2026-10-11)

In addition to C0–C7, adoption/implementation references are immutable [source provenance §42](42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md), [source-to-LLD §43](43-IMPLEMENTATION-SOURCE-LLD-PLAYBOOK.md) and [converged implementation plan](../docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md), governed by §17 A-V2-22..24. Source-to-owner paths, threat limits and UAT are per-entry in external-source-register.json. Control path remains first: P1.2-B → P1.3 → P2 managed Goal. No user permission to replace OpenCode Session, enter paid backend, or copy OMP runtime wholesale. Static catalog completeness and source byte-hash scan do not constitute runtime validation.
