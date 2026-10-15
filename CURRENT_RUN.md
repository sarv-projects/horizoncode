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

- Re-reviewed active architecture owner sections and the 46 active/compatibility `arch_V1` Markdown files for numbered headings, duplicate headings, code fences and escaped backtick formatting. The earlier estimate of 779+ upstream/reference Markdown files was unverified and is superseded by the complete Git-tree inventory below; inherited files remain non-normative.
- Compared real `kernel/src/{guard,effect_host,managed_control,owner_log,request_cancellation,protocol}.rs`, `kernel/src/bin/session_supervisor.rs`, `packages/core/src/session/supervisor.ts`, `packages/opencode/src/session/tool-batch.ts` and `indexd/src/lib.rs` against claimed runtime coverage. Updated the old §14.4 claim: guarded `files.write` is code-present; universal Guard is not.
- GitHub Actions logs revealed five duplicate/out-of-order sections and two absent provenance pointers in PR #7. Fixed headings to §2.12/§4.12/§5.13/§11.19/§12.15 and restored `42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md` references in active handoff/implementer.
- Added concrete HLD topology; IPC attach/subscribe/ack/detach/epoch, RAM sampler, measurement unit/counter types, resource pressure/leasing/cache eviction, headless worker/DAG/artifact verifier, provider Doctor, file-touch/advisory vs hard writes, model-context retrieval, TUI scheduler, session import/SDK/steering/experimental canary, privacy/OS and task-by-task fault tests. Added function/test coding ledger under the **existing** implementation plan; did not add an architecture owner.
- Work remains **docs-only**. Latest GitHub CI after final branch head must be checked; no machine PSS benchmark, native Windows/macOS, shared kernel cutover, new runtime schema or production feature was executed by this review. Next source gate remains P1.3 universal effect boundary, with RC0 read-only process-tree baseline in parallel.

## 2026-10-15 — third-pass cross-document and source-input audit

This earlier pass **incorrectly reported 904 Markdown files**, including 779 pinned OpenCode files. That count was not supported by the exact tracked Git tree and is superseded: on commit `dc61b665`, the complete recursive Git tree contains **278 tracked Markdown files** (46 `arch_V1`, 59 archive, 2 architecture-input, 152 pinned `opencode/`, 19 other). Inspected the current active architecture, operative plan, historical plan banners, source-input headings and live ACP server tree; preserved non-normative upstream/archive material. Found and replaced root OpenCode-centric SECURITY/CONTRIBUTING guidance; added non-authoritative `docs/README.md` navigation. Found accepted §03 deployment/visual/ACP journeys without complete §33/§37 interfaces, and added owner, Guard, tests and operative plan entries. No corresponding runtime implementations or native-OS/security/performance validations were performed. The complete machine-contract/sandbox/release/license gates remain open, and final-head CI must still pass.

## 2026-10-15 — current source/document cross-check and reservation accounting correction

- Re-inspected the latest PR #7 head rather than reusing the previous source snapshot. Direct/managed source truth stays in HANDOFF; this is not execution of universal Guard, shared-kernel code or RAM benchmarks.
- Checked active `arch_V1/` architecture plus `docs/` navigation/operative/historical sources for authority overlap and targeted structural contradictions. Old P2 plans and architecture-input documents are non-operative; upstream/archived Markdown is provenance, not live ownership. Accepted ACP/visual-source/deployment design is crosslinked in §§10/14/20/29/32/33/37; real code qualification remains pending.
- Found a resource-admission accounting bug in prose: §18.18 counted already-measured active worker memory again as a full reservation. Corrected to subtract only unconsumed reservation headroom, with process-generation reconciliation and exact integer arithmetic; added JC-RES-012.C–G cases in §32.37. Actual scheduler code/tests are not implemented by this docs-only change.
- Final-head CI, compiled machine contracts, hardware benchmarks and native OS security qualification remain required before runtime or release claims.

## 2026-10-15 — final active-owner consistency correction (PR #7)

- Re-read all 23 normative numbered `arch_V1` topic owners and current root/plan entry points on the active PR branch; scanned their explicit numbered owner references and found one dangling PF-004 `§31.18` reference, corrected to §§31.3/32.21. The 46 architecture Markdown files are present; the earlier 904-file assertion was incorrect and must not be reused for a completion claim.
- Reconciled inconsistent resource enums between §11.20, §18.18 and §12.16: seven reservation states, no `ACTIVE`/`UNKNOWN` aliases, exact pressure states, explicit quarantine/reconcile/release after uncertain process exit. Preserved the previously corrected unconsumed-reservation-headroom formula, so a measured worker is not debited twice.
- Bound design-level §37.17 ProviderDoctor network/full, FileTouch and HeadlessBroker methods to authenticated owner/epoch/Session/Attempt scope. Clarified §13.12 READY response vs ACTIVE state and §21.11 reservation transitions. Added §32.37 mandatory negative regression `JC-RES-012.H–L`; synchronized AGENTS, implementer instructions, and RC ledger. No application code or generated schemas changed.
- GitHub commits were pushed to existing docs PR #7. Actual Rust/TypeScript/OS work, no-bypass proofs, RAM benchmark, native Windows/macOS, source-build gates and exact final-HEAD CI are not established by this documentation review.

## 2026-10-15 — complete tracked Markdown structural scan and evidence correction

- **Exact immutable audit baseline:** PR #7 commit `dc61b6654f0b94547ccf2ea97cf13ae2c73ed1a2`. Its complete non-truncated recursive Git tree (`7,770` entries) has **278 tracked Markdown files** totaling **3,473,581 bytes and 52,523 parsed lines**. Breakdown: 46 `arch_V1`, 59 archived, 2 architecture-input, 152 vendored OpenCode, and 19 other project/support Markdown. Prior 904/779 inventory figures were erroneous, not alternative current counts.
- Retrieved **all 278** tracked Markdown blobs and scanned each line programmatically for fenced-code termination, merge-conflict markers and relative link targets against the complete tree. Found **no active-project broken local paths in this scan**, no unclosed fences or conflict markers. The initial scan found **62 flagged relative-link references**, all in archived/superseded material or vendored OpenCode files/fixtures. These are not automatically repaired because historical provenance and upstream test-fixture semantics must remain intact. Some may be deliberately absent generated artifacts rather than authoring mistakes.
- Audited actual Rust/source seams again: `managed_control.rs` explicitly declares its admission controller non-executing; per-Session supervisor spawn and guarded write path are present, but universal no-bypass, shared daemon, resource sampler, managed worker DAG and independently measured PSS are not proven. Proposed §12.16 machine schemas remain unimplemented; documenting a type is not generating a contract.
- Recorded an immutable **278-entry Git blob manifest** under `docs/audits/2026-10-15-tracked-markdown-structural-manifest.json` with source commit, file sizes, scope classes and historical/upstream link flags; subsequent edits require fresh generated evidence. Added `scripts/architecture/audit_markdown_repo.py` to re-inventory **every tracked Markdown file** on subsequent checkouts (no hard-coded count), classify non-normative material, validate active document links/headings/fences and optionally emit per-file SHA256/line/issue JSON evidence. Wired it to `run_push_gate.sh`, reached by the full CI script. The script and CI still need actual final-head execution to qualify; this remotely performed scanner pass is not a local build or a human semantic audit of every source sentence.
- Structural coverage **278/278 on the frozen base commit** is established. End-to-end semantic correctness and function-level implementation parity across all source code are **not** certified; missing executable machine schemas, runtime integration and platform acceptance remain implementation work. Re-run the tracked-file script against the newest commit to capture any files changed after the frozen baseline.


## 2026-10-15 — DOC-001..011 static gate implementation and repository scan hardening

GitHub PR #7 documentation-validation work (after the frozen 278-file baseline): added explicit static Horizon security/contributing identity, superseded-source precedence, ACP/visual/deployment owner trace, release-license/no-bypass disclaimers, reserved-capability status and plan linkage checks to the existing scripts/architecture/validate_convergence.py. These static guards are not equivalent to completing every DOC negative scenario. Enhanced scripts/architecture/audit_markdown_repo.py for HTML src/href, link-reference definitions, duplicate numbered headings and invalid UTF-8 across tracked Markdown; upstream/archive warnings retain non-authoritative scope. Preserve the immutable previous Git-blob manifest rather than overwriting it with a fresh-head claim. Tests and CI must be reported against the final branch SHA; no new runtime feature or RAM benchmark was performed by these source-validation changes.
