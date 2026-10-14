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
