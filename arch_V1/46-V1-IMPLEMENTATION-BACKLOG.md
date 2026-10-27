# V1 implementation backlog — code-only focus

**Use with:** `46-V1-DESIGN-AUDIT.md`, [`46-V1-RELEASE-EXECUTION-QUEUE.md`](46-V1-RELEASE-EXECUTION-QUEUE.md) (ordered waves 0–6 + subagents), [`46-V1-WIRE-TRACKER.md`](46-V1-WIRE-TRACKER.md) (done/not-done map), `10-DELIVERY.md`, `HANDOFF.md`.

Each row is **implementation + wire + test**; design is already in the cited `arch_V1` sections. Status reflects **codebase observation 2026-10-24**, not acceptance.

### 2026-10-24 status delta (parent re-observation; evidence cited, acceptance unchanged)

Rows below were re-checked against the current tree and their owner phase reports. Advancement is
**code present / focused-tested only**; no row became VERIFIED.

| Row | Was | Now | Evidence (2026-10-24) |
|---|---|---|---|
| P1-10 | OPEN | **CP** | Rust `effects.v2/prepare_tool_batch_read` implemented and focused **2/2**; Core private `repo_read` allowlist test **3/0, 10 expectations**; caller `packages/core/src/session/direct-read-batch.ts` in flight (P7), fence ruling recorded. Runtime-accepted? **No** |
| P3-05 | DES | **CP** | `packages/core/src/session/context-compile-policy.ts` + `packages/core/test/context-compile-policy.test.ts` present |
| P3-09 | DES | **CP** | `packages/core/src/session/project-instruction.ts` + instruction-project tests present; P3 instruction suite **21/0, 69 expectations** |
| P6-06 | DES | **CP** | `packages/core/src/config/coding-profile.ts` + `packages/core/test/config/coding-profile.test.ts` present; Settings chip rendering assigned to P4 in this wave |
| P7-08 | DES | **CP** | `packages/tui/src/util/code-display.ts` + `packages/tui/test/util/code-display.test.ts`; rerun **7/0, 31 expectations** |
| P9-03 | OPEN | **CP** | Installer/upgrade/dry-run/alias-refusal tests green; release readiness **82/82**. Real candidate build + clean install/rollback still **unrun** |
| P0-03 | PART | PART | release readiness **82/82**, `audit_distribution` BLOCKED (15), `release_gate` BLOCKED (20) |

### 2026-10-25 tracker reconciliation (audit; `reports/audit-v1-tracker-reconciliation.md`)

Six rows were **pessimistically stale — code is ahead of status** and the row must be re-read before
being treated as open:

| Row | Tracker said | Reality |
|---|---|---|
| P7-09 | OPEN | `/debug effects` fully implemented (`app.tsx:1794`, `prompt/index.tsx:514`, `dialog-debug.tsx`) — **0 tests**, so the row stays CP, not done |
| P3-10 | OPEN | `indexWarming`/`symbolFirst` coded **and tested**; only SPD-A `compileOverlapMs` is genuinely absent |
| W-P4-05 | not done | post-patch diagnostics wired in `apply_patch.ts:434-469` + `lsp/diagnostic.test.ts` |
| P3-11 | NOT STARTED (in `P3.md`) | P7 landed `transfer.ts` + `session-transfer.test.ts` **10/0 RUN** |

Seven rows have **path drift** (file exists, documented path does not): P1-01, P3-01, P4-02, P6-02,
P6-04, P6-07, P8-01. Six rows diverge between the wire tracker (`Not done`) and this backlog (`CP`):
W-P1-07, W-P3-05, W-P3-09, W-P6-06, W-P7-08, W-P9-03.

**Claimed-but-unverified (11):** **0 of 6 `PERF-DIRECT-*` rows have ever been executed** — no
p95/baseline number exists anywhere in `reports/`; B1 typecheck not green (Run C **25 diagnostics /
2 of 8 packages**); B5 free-model E2E **NOT_RUN with zero provider requests**; B6 RC0 **NOT_ATTESTED**
(allowlist empty); two `SELF-REPORT` rows.

**Verified so far: ~95 distinct `RUN` command+count records** across P1–P9 + A1 (registry claim
independently confirmed: **226 designed / 4 `code_present` of 230**). **0 of 9 phases VERIFIED.**

Rows that advanced to *partially integrated* but remain blocked by named owners: P1-01/P1-02
(focused Rust greens **11/11**, **10/10**, lib **79/79**, `direct_attempt_rpc` **10/10**; six matrix +
two terminal cases stay intentionally readiness-false), P5/P1-08 CodeMode (offline suite **128/0,
430 expectations**; Core adapter not landed), P8 rows (RC0 **109/109**, evaluator **43/43**,
JC-RES-012.I TS consumer **9/9**; trusted attestation allowlist empty → NOT_ATTESTED).

**Still OPEN with no code:** P1-11 (`PERF-DIRECT-001`, parent measurement), P3-10 (SPD-A/B/D — no
`compileOverlapMs`/`index_warming` consumer found in tests), P7-09 (`PERF-DIRECT-*`, ACT-023 unrun).
**Design-only/unavailable:** P5-03 browser/desktop (post-V1 per A-V2-31).

Legend: **DES** designed only · **CP** code present partial · **PART** partial integration · **OPEN** not started

---

## P0 — Base pin (`10` §10.2)

| ID | Deliverable | Normative arch | Schemas / contracts | Code seams (`20`/`37`) | Tests | Status |
|---|---|---|---|---|---|---|
| P0-01 | Preserve OpenCode-derived tree; single runtime | `20` §20.1–20.3, `01` §01 | — | `packages/opencode`, `packages/core` | — | CP |
| P0-02 | Provenance pins in `42` | `42` | `source-artifact-v1` | `repo_take/NOTES.md` | — | CP |
| P0-03 | Build/install scripts | `18` §18, `10` §10.11 | — | `install`, `packages/opencode/script/build.ts` | release gates §32 | PART |

---

## P1 — Guard / ExecutionHost (`10` §10.3, `14`)

| ID | Deliverable | Normative arch | Schemas / contracts | Code seams | Tests | Status |
|---|---|---|---|---|---|---|
| P1-01 | ToolBatch Guard before dispatch | `14` §14.8–14.24, `03` §3.3 | `tool-batch-control-v1`, `effect-boundary-v1` | `kernel/src/guard.rs`, `kernel/src/effect_host.rs`, `packages/core/src/session/tool-batch.ts` | §32.14 TB-*, PS-* | PART |
| P1-02 | PREPARE / one-use lease / receipt | `14`, `11` §11.5 | `execution-protocol-receipt-v1`, `delegation-binding-v1` | `kernel/src/host_kernel.rs`, `kernel/src/protocol.rs` | §32.20, MPT-001 | PART |
| P1-03 | UNKNOWN reconciliation | `04` §4.7–4.8, `15` | `managed-event` (OwnerLog V2) | `kernel/src/verifier_journal.rs`, `worker_durable.rs` | §32.19 RC-* | PART |
| P1-04 | Sandbox / cgroup containment | `14` §14.18+, `horizoncode-sandbox` | harness profiles | `horizoncode-sandbox/`, `kernel/src/worker_pool.rs` | §32.14, PS-* | PART |
| P1-05 | `terminal.run` shell + **workspace profile** modes | `37.27`, `33` §33.7, `17` DEC-V1-28 | `execution-launch-profile-v1` | `kernel/src/terminal_process.rs`, `packages/core/src/tool/bash.ts` (fail-closed) | §32.7, §32.43 GRANT-* | OPEN/PART |
| P1-06 | Direct session observer / SessionLink | `13`, `20` §20.4 | `session-link-v1` | `packages/core/src/session/supervisor.ts` | §32.12 LANE-* | PART |
| P1-07 | SecretBroker / credentialed effects gate | `05`, `37` auth | — | `packages/opencode/src/auth/secret-broker.ts` | §32.21 auth rows | PART |
| P1-08 | CodeMode EffectHost wave/receipt binding | `37.24`, `14` | codemode schemas in `12` | `kernel/src/effect_host.rs`, `packages/opencode/src/tool/code-mode.ts` | §32.41 CM-* | PART |
| P1-09 | External editor launch + containment | `37.28`, `16` §16.20, DEC-V1-33 | `debug-session-action-v1` (patterns) | `kernel` editor journal seam | §32.44 EDITOR-* | PART |
| P1-10 | **DEC-V1-36** read fast path + batched read RPC | `14` §14.3.1, `03` §3.2 | `prepare_tool_batch_read`, Core classifier | PERF-DIRECT-002,004 | CP |
| P1-11 | Warm kernel IPC pool (provider not blocked) | `13` §13.2, `DEC-V1-36` | `session_supervisor`, kernel hello | PERF-DIRECT-001 | OPEN |

**P1 exit gate:** §10.3 — no mutation bypass on tested paths; §32.14 negatives green; §32.49 read-path parity on warm kernel.

---

## P2 — Managed control plane (`10` §10.4, `11`, `29.18`)

| ID | Deliverable | Normative arch | Schemas | Code seams | Tests | Status |
|---|---|---|---|---|---|---|
| P2-01 | Goal / SpecVersion / Run / Task / Attempt | `02`, `11` | domain schemas `12` | `kernel/src/managed_control.rs`, `automation.rs` | §32.9 | PART |
| P2-02 | Single-Task vertical → **bounded DAG** | `DEC-V1-31`, `29.18`, `21` | `plan-handoff-v1`, `subagent-delivery-v1` | `kernel/src/worker_durable.rs`, `worktree_lifecycle.rs` | §32.9, §32.12 SA-* | PART |
| P2-03 | Per-Task verifier + Run settlement | `11`, `03` §3.4 | `managed-event`, evidence refs | `kernel/src/managed_verifier.rs` | §32.9, MPT-001 | PART |
| P2-04 | `managed_context.advance` | `30` §30.24, `37` | `context-selection-v1` | `packages/opencode/src/session/llm.ts`, `kernel` OwnerLog | §32.45 CTX-* | PART |
| P2-05 | `providers.infer` Guard action | `37.23`, `17` §17.25 | capability `providers.infer` | `kernel/src/http_execution.rs` | LANE-003, §32.12 | CP registry only |
| P2-06 | Direct session artifact index API | `37.12`, `15` §15.2 | `source-artifact-v1` | `kernel` batch index, `SessionSupervisor.listDirectSessionArtifacts` | artifact rows §32.16 | PART |
| P2-07 | CodeMode managed start (no caller lease) | `37.24` | — | HostKernel prepare path | CM-* | PART |

**P2 exit gate:** §10.4; DEC-V1-31 multi-Task when P8 leases ready.

---

## P3 — RepoIntel + context (`10` §10.5, `30`)

| ID | Deliverable | Normative arch | Schemas | Code seams | Tests | Status |
|---|---|---|---|---|---|---|
| P3-01 | `ensure_generation` + `query_structure` | `30.22–23`, `37.22` | `repo-intelligence-query-v1`, `language-service-snapshot-v1` | `indexd/`, `kernel` repo_structure, `supervisor.ts` | §32.4 RD-* | PART |
| P3-02 | `repo.tree` / `repo.detect` registration | `33` §33.5, `30.25` | capability registry | `packages/opencode/src/tool/repo-tools.ts` | RD-*, V1-ADAPT-004 | PART (gated) |
| P3-03 | ContextSelection pin (direct) | `30.24`, `DEC-V1-32` | `context-selection-v1` | `packages/core/src/session/context-selection.ts` | CTX-001 | CP |
| P3-04 | ContextLedger compile + stream | `30.2`, `31` | `context-ledger-v2` | `packages/core/src/session/context-ledger.ts`, runner `llm.ts` | CTX-001–005 | PART |
| P3-05 | **§30.26** policy resolver + anchor | `30.26`, `37.30` | `context-compile-policy-v1`, `repo-context-anchor-v1` | *new* `context-compile-policy.ts`, RepoIntel builder | CX-014–021 | CP |
| P3-06 | Pressure ops `/trim` `/prune` `/compact` | `30.3–30.4` | — | `packages/core/src/session/compaction.ts`, OpenCode `SessionCompaction` | CX-001–010 | PART |
| P3-07 | Progressive tool discovery | `29`, `31` §31.21 | `harness-profile-v1` | `packages/core/src/tool/registry.ts` | CX-008, LM-* | PART |
| P3-08 | History search bounded SQL | `30.12`, `30.24 P3 note` | — | Core history tools | CX-004, UI-019 | PART |
| P3-09 | **§29.23** project instruction resolver | `29.23`, `30.2` | extend `context-ledger-v2` reasons | *new* `project-instruction.ts`, Core `ContextService` | CX-022–025, INST-001–008 | CP |
| P3-10 | §30.28 SP-A/C symbol-first + async index | `30.28`, `30.25` | `indexd`, ContextService | SPD-A,B,D | OPEN |
| P3-11 | Session import/export | `30.30` REL-N, §42 | OpenCode transfer seam | REL-* | PART |

**P3 exit gate:** §10.5; repo tools exposed only when P1+P3 acceptance passes.

---

## P4 — LSP / DAP / REPL (`10` §10.6, `37.6–8`)

| ID | Deliverable | Normative arch | Code seams | Tests | Status |
|---|---|---|---|---|---|
| P4-01 | LanguageServiceBroker | `37.6`, `30.7` | `packages/opencode/src/lsp/` | §32.28 LS-* | PART |
| P4-02 | Repo document read via HostKernel | `30.22`, `37.22` | `repo-document-reader.ts` | LS-* | PART |
| P4-03 | DAP broker | `37.7` | `packages/opencode/src/dap/` | §32.28 | PART |
| P4-04 | REPL broker | `37.8`, `33` §33.9 | `packages/opencode/src/repl/` | §32.28 | PART |

---

## P5 — Web search + CodeMode (`10` §10.7, `37.5`, `37.24`)

| ID | Deliverable | Normative arch | Code seams | Tests | Status |
|---|---|---|---|---|---|
| P5-01 | `web.search` cascade | `37.5`, `DEC-V1-26`, `33.9` | `websearch-broker.ts`, `kernel` routes | §32.28 WS-* | PART |
| P5-02 | CodeMode helper process | `37.24`, `29.22` | `code-mode.ts`, sandbox | §32.41 CM-* | PART |
| P5-03 | Browser/desktop | **post-V1** A-V2-31 | — | §32.15 | DES/unavailable |

---

## P6 — Providers / settings / Doctor (`10` §10.8, `16`, `37.16–19`)

| ID | Deliverable | Normative arch | Code seams | Tests | Status |
|---|---|---|---|---|---|
| P6-01 | Models.dev catalog | `30.24`, `16` §16.5 | `packages/core/src/models-dev.ts` | PD-*, FEAT-* | CP |
| P6-02 | Direct provider transport + journal | `DEC-V1-32`, `17` §17.26 | `provider-transport.ts`, `runner/llm.ts` | LANE-004, §32.21 | PART |
| P6-03 | Provider Doctor tiers | `37.18` | `provider/doctor.ts` | PD-*, §32.31 | PART |
| P6-04 | Settings / feature exposure | `16`, `33` feature registry | `config.ts`, `feature-exposure.ts` | FEAT-001–014 | PART |
| P6-05 | AgentProfileV2 registry | `29`, `12` | `kernel/src/agent_profile.rs`, Core config | §32.12 | PART |
| P6-06 | **Horizon Coding Profile** (`DEC-V1-37`) | `16` §16.19, `33.33` | feature exposure + `/permissions` | PERF-DIRECT-005, SPD-*, EXP-* | CP |
| P6-07 | **Tool/skill tiers** + `builtin.horizoncode` register | `29.6`, `33.32`, `DEC-V1-38` | `skill.ts`, `opencode/src/skill`, `horizon/skills/horizoncode/` | EXP-001–005 | PART (sealed builtin registered; Core/Extended/Experimental enforcement + chips open) |

---

## P7 — TUI / streams / artifacts (`10` §10.8 P7, `31`, `16`)

| ID | Deliverable | Normative arch | Code seams | Tests | Status |
|---|---|---|---|---|---|
| P7-01 | UiEventMux / stream lanes | `37.11`, `31.1` | `packages/tui/`, server SSE | UI-001–007 | PART |
| P7-02 | Context bar + ledger projection | `30.2`, `16` | TUI context components | CTX-002, UI-* | PART |
| P7-03 | Activity digest §31.22 | `31.22`, `16.21` | `activity-stream.tsx` | ACT-001–024 | PART |
| P7-04 | Artifact render service | `37.12`, `31.5` | artifact pipelines | UI-008–010 | PART |
| P7-05 | Checkpoint / rewind UI | `31.18`, `16.18`, DEC-V1-25 | `/checkpoints` dialog | CP-001–002 | PART |
| P7-06 | Automations UI | `31.12`, `37.10` | HTTP API automation routes | §32.18 AU-* | PART |
| P7-07 | Provider settlement EventV2 | `15`, `31` | `session/runner/llm.ts` | UI-017, LANE-* | PART |
| P7-08 | **§31.23** code display + highlight RAM | `31.23`, `37.12` | `CodeDisplayPipelineV1` | TUI `artifact-markdown.tsx`, review overlay | UI-024–030, ACT-004/005 | CP |
| P7-09 | `/debug effects` + slash parity §16.4.1 | `31.24`, `16` | TUI help + diagnostics | PERF-DIRECT-*, ACT-023 | OPEN |

---

## P8 — Worktrees / resources (`10` §10.9, `21`, `18.17–18`)

| ID | Deliverable | Normative arch | Code seams | Tests | Status |
|---|---|---|---|---|---|
| P8-01 | Worktree pool + leases | `21`, `37` | `kernel/worktree_pool.rs` | §32.33 GS-* | PART |
| P8-02 | Resource sampler / pressure | `18.18`, `37.17` | `resource_sampler.rs`, `resource_budget.rs` | §32.32 JC-RES-* | PART |
| P8-03 | Distinct-Location multi-Task | `21.11`, P2 coordination | HostKernel child locations | VEO-021, SA-* | PART |
| P8-04 | Cache registry retirement | `30.21`, `37` P8 notes | HostKernel + P8 row | JC-RES-012 | PART |

---

## P9 — Release (`10` §10.11, `18`)

| ID | Deliverable | Normative arch | Tests | Status |
|---|---|---|---|---|
| P9-01 | `horizoncode` / `hzcode` CLI | `18`, `10` §10.12 | install smoke | PART |
| P9-02 | CI qualification workflow | `18.18` | `.github/workflows/` | PART |
| P9-03 | Clean install / upgrade | `18` | §32 release rows | CP |

---

## Cross-phase wiring checklist (do not skip)

| Edge | Upstream | Downstream | Owner doc |
|---|---|---|---|
| Tool effect | P1 receipt | P7 TUI tail | `31.16`, `14` |
| Managed prompt | P2 advance digest | P6 transport | `30.24` |
| Repo read | P1 `files.read` | P3 generation | `30.22` |
| CodeMode wave | P1 EffectHost | P2 persistence | `37.24` |
| Context tier | P6 models.dev | P3 compile | `30.26`, `37.30` |
| Multi-Task | P8 lease | P2 scheduler | `DEC-V1-31` |

---

## Implementation order suggestion (parallel where safe)

1. **P1** effect path + terminal profiles (blocks almost everything effectful).
2. **P6** direct transport settlement (user-visible coding).
3. **P3** context ledger + §30.26 resolver (cost/context).
4. **P2** managed vertical + artifacts API.
5. **P7** UI acceptance surfaces.
6. **P4/P5** brokers (parallel after P1).
7. **P8** fan-out after P2 single-Task proof.
8. **P9** last.

Update [`46-V1-WIRE-TRACKER.md`](46-V1-WIRE-TRACKER.md) **Status** and this file when a row moves to WIRED; cite test command + revision in `HANDOFF.md`.

---

## Operator notes — model-slug resolution must self-inspect (2026-10-26)

Observed in orchestration: resuming a subagent with `model: "inherit"` (a retry convention from the root `AGENTS.md` quota-recovery rule) failed with `Invalid model "inherit". Use "providerID/modelID" or "providerID/modelID#variant"`, while a separate dispatch path returned `subscription_sharing_usage_limit_exceeded` even after the user reset quota. Recovery required an operator step outside the product: enumerate the live provider/model catalog (`models` registry lookup) and re-dispatch with the exact working slug (here `opencode-go/mimo-v2.6-flash`).

**Requirement:** when HorizonCode's Task/subagent dispatch rejects a model reference — invalid slug, alias, stale or unavailable model — it must be able to *inspect itself*: resolve the referenced provider/model against its own canonical model registry (the same authority as the capability/provider catalog), list the valid live slugs for the caller's provider, and either retry with an approved live model under the user's model-selection policy (`A-V2-03`: no silent model switching) or return the exact valid catalog with the error. Quota/limit errors must likewise surface the failing provider, remaining/reset context when knowable, and the approved fallback path — never a bare harness error that forces an operator to guess a slug.

Constraints: self-inspection is read-only registry access, not a provider call; any automatic re-selection still obeys the user's pinned provider/model/harness and requires the same authorization as the original dispatch. This note is a product-behavior requirement candidate for the Task/dispatch seam (`37`, `32` acceptance rows); it is not yet implemented or tested.
