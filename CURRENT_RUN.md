# CURRENT_RUN — HorizonCode engineering activity and evidence log

**Status:** dated implementation diary. This is **not** canonical product architecture, a second issue tracker, nor proof of runtime capabilities. Normative owners: `arch_V1/README.md` → exact topic file; observed implementation status: `HANDOFF.md`; execution order: `docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md`. Historic pre-consolidation CURRENT_RUN remains preserved under `docs/architecture-archive/`.

## 2026-10-15 — JCode resource/performance adoption documentation

**Source context:** HorizonCode `main@4e2086633d006f7d8b7709cb0df622f77a9b8d54`, JCode pinned `1jehuang/jcode@1f612a7`; derived uploaded `jcode-godmap.zip` (157 Markdown source map). This is a remote GitHub/docs audit and update, **not** a full local build/runtime validation. Separate source-derived claims from proven runtime.

### Confirmed source baseline

- Current `packages/core/src/session/supervisor.ts` launches one Linux `session_supervisor` Rust child per watched direct Session. Its current implementation is a Session event observer/effect endpoint, not a shared Rust multi-session daemon. Existing `SessionSupervisor` service and authenticated RPC remain the integration surface.
- Existing Rust `kernel/src/owner_log.rs`, `managed_control.rs`, `guard.rs`, `effect_host.rs`, `request_cancellation.rs` are real code. Managed control is explicitly a **non-executing** admission/state machine; production scheduler/executor/independent verification and universal mutation enforcement are incomplete.
- `indexd/src/lib.rs` provides bounded in-memory lexical/index overlay operations; persistent symbol/reference intelligence and platform/benchmark work remain gated.
- No HorizonCode-versus-JCode same-machine PSS/RAM/task-completion test was run. JCode's public PSS values are **JCode measurements**, not HorizonCode expectations. JCode's 2026 design docs carry different statuses (including Proposed, Draft, Being implemented).

### Adopted documentation decisions (A-V2-30)

- Shared-kernel candidate with authenticated virtual Session attachments; preserve Core session ownership and Guard/ExecutionHost; proof of fault isolation before replacing present per-Session effect process path.
- Entire process-tree memory/FD/CPU/disk and per-owner cache/VRAM accounting, redacted local diagnostics, fair pressure backpressure and owned cleanup.
- Headless specialists and DAG scheduling under **one Rust Task/Attempt owner**, typed dependency artifacts, reviewer coverage/final revision evidence.
- Provider Doctor with no-spend offline tier, consented catalog/full tiers, explicit auth/provider/model route; safe prewarm only.
- Advisory cross-session file-touch + authoritative stale digest/lease guard; adaptive TUI rendering and bounded live tool-tail; optional scoped memory recall and external session import/resume.
- Design-only features remain DESIGNED. No machine contract/CLI UI/API operational status was promoted by these Markdown edits.

### GitHub documentation output

Branch: `docs/jcode-resource-runtime-adoption-20261015`. The relevant existing topic owners have new A-V2-30 sections, and `docs/performance/README.md` is a non-normative empty measurement protocol. Existing historical documentation is intentionally retained. No performance benchmark, source-runtime implementation, or new external provider integration was performed by these commits. Treat any PR CI as documentation/contract validation only.

### Next exact engineering work (unchecked)

1. Inspect the current working tree and newest main/branch, protect user changes, list process/worktree/disk owners. Run current focused and full gates to establish baseline.
2. Close P1.3 direct shell/process and Task/subagent mutation bypasses with real pre-dispatch Rust Guard/ExecutionHost, negative tests, cancel/UNKNOWN and no hosted-provider escape. Record CI and OS proof in HANDOFF.
3. In parallel (safe/read-only), instrument current observer and total process-tree RAM/FD/process/CPU, cache bytes, UI idle redraw, cold/warm startup. Add actual reproducible benchmark scripts; run 1/5/10/20 Sessions on stable declared hardware and store raw outputs.
4. Wire authenticated P2 SpecVersion + DAG scheduler + bounded WorkerExecution/Attempt leases and independent final revision verification. Do not replace Rust Task ownership.
5. Trial shared *read-only* Rust observer; prove cross-session denial, restart/UNKNOWN, input fairness and measured benefit **before** shared effect-host cutover.
6. Integrate Provider Doctor, resource telemetry, file-touch advisory, headless worker pool, TUI redraw/tool-tail, memory cache caps and external session resume via exact §20/§37 seams. Iterate RC0–RC4 from operative plan with §32.32 tests.
7. Record each TESTED/VERIFIED claim with exact platform, run, pass/fail, raw task/artifact link and known unavailable paths. Update `HANDOFF.md` (not this diary) as the current truth.

### Explicitly not done by this doc-only activity

- No GitHub PR check or native Windows/macOS/system-level benchmark was performed as part of the source audit.
- No shared daemon, resource telemetry sampler, Provider Doctor, file-touch index, DAG scheduler, import/resume adapter or TUI change has been coded by this documentation change.
- No third-party code was copied; license/copyright verification is required before extraction. Existing Horizon main legal/release tasks remain open.

### Guardrails for continuation

Actual tests outrank prose. User-pinned model/harness/provider must not change as a result of RAM pressure; do not delete dirty/unowned worktrees or purge build caches to manufacture a RAM/disk win. Respect experimental enablement/visibility controls, OS sandbox honesty and strict pre-dispatch Guard for all mutation origins. Keep CANONICAL → DERIVED ownership distinctions intact.

## 2026-10-15 — second-pass HLD/LLD hardening and GitHub CI correction

- Re-reviewed active architecture owner sections and the 46 active/compatibility `arch_V1` Markdown files for numbered headings, duplicate headings, code fences and escaped backtick formatting. Retained 779+ upstream OpenCode/reference files as non-normative source/compatibility material; no claim of semantic line-by-line review of all inherited vendor Markdown.
- Compared real `kernel/src/{guard,effect_host,managed_control,owner_log,request_cancellation,protocol}.rs`, `kernel/src/bin/session_supervisor.rs`, `packages/core/src/session/supervisor.ts`, `packages/opencode/src/session/tool-batch.ts` and `indexd/src/lib.rs` against claimed runtime coverage. Updated the old §14.4 claim: guarded `files.write` is code-present; universal Guard is not.
- GitHub Actions logs revealed five duplicate/out-of-order sections and two absent provenance pointers in PR #7. Fixed headings to §2.12/§4.12/§5.13/§11.19/§12.15 and restored `42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md` references in active handoff/implementer.
- Added concrete HLD topology; IPC attach/subscribe/ack/detach/epoch, RAM sampler, measurement unit/counter types, resource pressure/leasing/cache eviction, headless worker/DAG/artifact verifier, provider Doctor, file-touch/advisory vs hard writes, model-context retrieval, TUI scheduler, session import/SDK/steering/experimental canary, privacy/OS and task-by-task fault tests. Added function/test coding ledger under the **existing** implementation plan; did not add an architecture owner.
- Work remains **docs-only**. Latest GitHub CI after final branch head must be checked; no machine PSS benchmark, native Windows/macOS, shared kernel cutover, new runtime schema or production feature was executed by this review. Next source gate remains P1.3 universal effect boundary, with RC0 read-only process-tree baseline in parallel.

## 2026-10-15 — third-pass cross-document and source-input audit

Re-inventoried 904 Markdown files at PR #7 reviewed base: 46 active/compatibility `arch_V1`, 779 pinned OpenCode, 59 archived and 20 other root/project/plan sources. Inspected the current active architecture, operative plan, historical plan banners, source-input headings and live ACP server tree; preserved non-normative upstream/archive material. Found and replaced root OpenCode-centric SECURITY/CONTRIBUTING guidance; added non-authoritative `docs/README.md` navigation. Found accepted §03 deployment/visual/ACP journeys without complete §33/§37 interfaces, and added owner, Guard, tests and operative plan entries. No corresponding runtime implementations or native-OS/security/performance validations were performed. The complete machine-contract/sandbox/release/license gates remain open, and final-head CI must still pass.

## 2026-10-15 — current source/document cross-check and reservation accounting correction

- Re-inspected the latest PR #7 head rather than reusing the previous source snapshot. Direct/managed source truth stays in HANDOFF; this is not execution of universal Guard, shared-kernel code or RAM benchmarks.
- Checked active `arch_V1/` architecture plus `docs/` navigation/operative/historical sources for authority overlap and targeted structural contradictions. Old P2 plans and architecture-input documents are non-operative; upstream/archived Markdown is provenance, not live ownership. Accepted ACP/visual-source/deployment design is crosslinked in §§10/14/20/29/32/33/37; real code qualification remains pending.
- Found a resource-admission accounting bug in prose: §18.18 counted already-measured active worker memory again as a full reservation. Corrected to subtract only unconsumed reservation headroom, with process-generation reconciliation and exact integer arithmetic; added JC-RES-012.C–G cases in §32.37. Actual scheduler code/tests are not implemented by this docs-only change.
- Final-head CI, compiled machine contracts, hardware benchmarks and native OS security qualification remain required before runtime or release claims.
