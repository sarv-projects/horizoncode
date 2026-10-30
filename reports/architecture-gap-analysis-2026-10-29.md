# Architecture gap analysis — HorizonCode vs the agentx design brief

**Date:** 2026-10-29 · **Mode:** read-only audit of `/home/sarvesh/business_Dev/agentx` (WSL2) · **Files written:** this report only.

## 0. Basis (measured today, not re-measured here)

| metric | value |
|---|---|
| solved / run | 4/6 — 11099, 15503, 9296, 11211 solved; 11820, 13410 not |
| runnable-test regressions | 0 |
| tool calls | 246 — bash 170, read 42, edit 15, grep 12, glob 6, write 1 |
| tool errors | 35 (14%); 3–11 per task |
| label coverage | 15–61 PASS_TO_PASS labels per task unrunnable (label→runner mismatch) |

All 35 tool errors, extracted from `.tmp/nemotron-bench/logs/*/messages.json` (existing artifacts):

| n | error text | product source |
|---|---|---|
| 18 | `Ripgrep is unavailable until HostKernel Guarded read execution is wired` | `packages/core/src/ripgrep.ts:96` |
| 12 | `Tool batch denied: Rust returned a batch admission outside the complete-batch path` | `packages/opencode/src/session/tool-batch.ts:1352` |
| 3 | `Tool batch denied: invalid tool arguments` | model-side |
| 2 | `Edit denied: guarded operation set or lease changed` | `packages/opencode/src/tool/edit.ts:214` |

grep+glob were called 18 times and failed 18 times (**100%**). bash is **69%** of all calls. Every bash result was prefixed by two `.profile` error lines (**316 noise lines** across 6 runs).

## 1. Verdict

- **Right for this product:** item 2 (in-process tools), the output-scrubbing half of item 3, item 8's verification-substitution insight, and item 9's dual-layer ingestion — which is already built.
- **Wrong:** the brief is a *context-efficiency* brief. **32 of 35 tool errors (91%)** are product defects — a dead search route, a ToolBatch admission bug, and edit's double-prepare lease check — and the two unsolved tasks failed on **verification substitution** (13410 wrote its own script, saw `All ad-hoc checks passed!`, stopped) and **single-edit stall** (11820: 1 edit, 44 calls, 43 model requests).
- **Single biggest thing it gets wrong:** it assumes the tools are *slow* and need compression/routing. Here they are *absent*. Hashline, an AST funnel, compaction epochs and a tool router would not have changed any of these six runs; restoring grep/glob removes 18 failed calls and most of the 170 bash calls underneath them.

## 2. Findings table

| Item | Bucket | Evidence (file:line) | Action | Est. diff |
|---|---|---|---|---|
| 1a. Hashline line-hash anchors | POST-RELEASE | `packages/opencode/src/tool/read.ts:349` emits `N: line` only; `packages/opencode/src/tool/edit.ts:801-832` is a 4-stage fuzzy chain (exact → line-trimmed → block-anchor Levenshtein → whitespace); `packages/core/src/v1/config/feature-exposure.ts:278` declares `hashline_edit` with `defaultEnabled:false` | 0 anchor misses in 15 edits today; build only when edits/task exceed ~5 | ~600 LOC |
| 1b. `assert_seen_lines` provenance | POST-RELEASE | `packages/opencode/src/tool/edit.txt:4` promises "will error if you attempt an edit without reading the file"; `grep -rn "wasRead\|assertRead\|seenFiles"` over `packages` → **nothing** | make the promise true (§4.6) | ~40 LOC |
| 2. In-process tools (ripgrep/glob/brush shell) | **BEFORE-HACKATHON** | `packages/opencode/src/tool/grep.ts:24` and `glob.ts:21` inject `Ripgrep.Service`; `packages/core/src/ripgrep.ts:96` returns `false` unconditionally; the in-process replacement already exists at `packages/core/src/filesystem/search.ts:161-180` (`{mode:"regex", timeBudgetMs:1500}`) | repoint the two leaf tools at `FileSystemSearch` (§3.1) | 40–80 LOC |
| 3a. Ingestion-time output scrubbing | **BEFORE-HACKATHON** | `packages/core/src/shell.ts:12` (`bash: { login: true }`) → `packages/core/src/pty.ts:853` appends `-l` → `kernel/src/terminal_profile.rs:67` `--login`; `kernel/src/host_kernel.rs:36253-36275` head-cuts 50 KB/2000 lines with no ANSI strip | `login:false` for the coding profile + scrub preview (§3.2) | ~30 LOC |
| 3b. AST funnel: repo map → skeleton → symbol slice | POST-RELEASE | `indexd/src/repo_intel.rs:93-100` answers symbol/reference/impact with `UnsupportedOperation`; `packages/opencode/src/tool/registry.ts:75` sets `REPO_INTEL_TOOL_ACCEPTANCE_READY = false`, gated at `registry.ts:294` | needs a parser-backed indexd; repo-map half is already wired (`registry.ts:300` discovery gate) | 2–3k LOC |
| 4. Virtual tool router (2 meta-tools) | POST-RELEASE | `packages/opencode/src/tool/registry.ts:248-283` publishes ~25 schemas per request; `grep -rn "tool_search\|metaTool\|toolRouter"` over `packages/{opencode,core}/src` → **nothing** | defer; schemas sit in the cached prefix and MCP is not multiplying them yet | ~300 LOC |
| 5. 4-zone prompt + cache-control placement | **HAVE** | `packages/core/src/system-context/index.ts:33-42` (per-source baseline/update deltas), `packages/core/src/session/context-epoch.ts:29-60` (durable epoch snapshots), `packages/opencode/src/provider/transform.ts:1319-1332` (`prompt_cache_key`), `transform.ts:370-376` (`cache_control`/`cachePoint`); real runs show nonzero provider cache reads | delete `packages/opencode/src/session/system.ts:84` (`Today's date`) — the only non-deterministic line | 1 line |
| 6. Epoch-quantized compaction + fold-before-prefix | POST-RELEASE | `/trim` `context-ops.ts:128`, `/prune` `context-ops.ts:180`, auto-compact at overflow `packages/opencode/src/session/overflow.ts:26-35`, fold constant `compaction.ts:39,61`; **zero `compaction`/`ContextUpdated` events** in all six `events.jsonl` | nothing before the hackathon; real gap is folding at ingestion (§4.7) | ~400 LOC |
| 7. Shadow-workspace validation + LSP bounce | POST-RELEASE | `packages/opencode/src/lsp/launch.ts:37-39` returns `false`, so `registry.ts:284` never exposes the LSP tool; `launch.ts:42-44` also `false` (host protocol) | no shadow workspace is useful while no language service can start; 0 regressions measured, so this is not the current ceiling | 1–2k LOC |
| 8a. Anti-cheat AST structural diff | POST-RELEASE | only check is harness-side, `scripts/e2e/nemotron-bench.sh:1155-1172`; `grep -rn "ts-ignore\|ts-expect-error\|#\[ignore\]"` over `packages/opencode/src/tool kernel/src` → **nothing** | move the tamper rule into the Guard path (§4.2) | ~500 LOC |
| 8b. Signed `VerificationReceipt` | POST-RELEASE | `grep -rIn "merkle\|VerificationReceipt"` over `kernel packages` → **nothing**; kernel receipts are effect-scoped (`kernel/src/managed_control.rs:19319`) | §4.1 — highest-risk omission for release | ~800 LOC |
| 9a. models.dev dual-layer (`models.json` + `api.json`) + dual-ID | **HAVE** | `packages/core/src/models-dev.ts:196` (`models.json`), `:231` (`/api.json`); dotted-id/prefix normalization at `packages/opencode/src/provider/provider.ts:937-958` | none | 0 |
| 9b. Role-based tiered routing | POST-RELEASE | `grep -rn "planner\|explorer\|patchApplier"` over `packages/core/src/model.ts packages/core/src/harness-profile.ts` → **nothing**; bench pins one model (`metrics.env`: single `STEP_MODELS` id) | worth an eval, not a hackathon change | ~200 LOC |
| 10. Light self-learning (hindsight + ε-greedy router) | **IGNORE** | `grep -rIln "hindsight\|trajectory\|lessons"` over `packages/{opencode,core}/src` → **nothing**; `grep -rn "tokens_per\|epsilon"` → **nothing**; corpus = 6 runs, 2 failure modes | revisit at ≥200 verified runs | — |

## 3. BEFORE-HACKATHON — top 5

### 3.1 Turn grep/glob back on, in-process (brief item 2) — 18/18 calls failed

- **Why it moves the numbers:** 18/18 grep+glob failures = 51% of all tool errors and 7% of all calls; bash absorbs the work at 170 calls (69%). On 13410 the run's first three moves were `grep`, `glob`, `grep` — all dead — before it fell back to `find`/`ls` through bash.
- **Files:** `packages/opencode/src/tool/grep.ts:24`, `packages/opencode/src/tool/glob.ts:21`; dead gate `packages/core/src/ripgrep.ts:96`; working in-process search `packages/core/src/filesystem/search.ts:161-180`.
- **Change:** add a `Ripgrep.Interface` layer backed by `FileSystemSearch` (its `find`/`glob`/`grep` already return the same `Entry`/`Match` rows) and swap `Ripgrep.node` at `packages/opencode/src/tool/registry.ts:445` and `packages/opencode/src/effect/app-runtime.ts:127`. No child process, so `ripgrepProcessRouteAvailable()` stays `false` and no Guard invariant is touched.
- **Verify (≤10 min):** `cd packages/opencode && bun test test/tool/grep.test.ts test/tool/glob.test.ts 2>&1 | tail -3` (0 failures, 0 occurrences of `Ripgrep is unavailable`) and `cd packages/core && bun test test/filesystem/search.test.ts`.

### 3.2 Stop the login shell from prefixing every result (brief item 3, scrubbing half) — 316 noise lines

- **Why it moves the numbers:** 2 lines × 170 bash calls of `/.cargo/env: No such file or directory`, inside every tool result — i.e. inside the cached prefix of every later request. It is also why 13410 burned calls locating `venv/bin/python` and then hand-wrote `PYTHONPATH=` on every test command.
- **Files:** `packages/core/src/shell.ts:12` (`bash: { login: true }`) → `packages/core/src/pty.ts:853` (`-l`) → `kernel/src/terminal_profile.rs:67` (`--login`); preview builder `kernel/src/host_kernel.rs:36253`.
- **Change:** (a) `login: false` for `bash`/`zsh`/`sh` in the coding profile — a login shell is wrong for an agent shell regardless of `$HOME`; (b) in `terminal_preview`, strip ANSI CSI/OSC sequences and drop leading `*.profile`/`*.bashrc` diagnostics before the head cut.
- **Verify (≤10 min):** `cd packages/core && bun test test/shell.test.ts 2>&1 | tail -3`, then one `bash` tool call (`echo ok`) and confirm the preview is exactly `ok`.

### 3.3 Fix the complete-batch admission denial (not in the brief) — 12/35 errors, 4/6 runs

- **Why it moves the numbers:** largest non-search error class. In 11820 it denied 4 of the first 8 bash calls — the whole opening sequence — the direct cause of 43 model requests producing 1 edit.
- **File:** `packages/opencode/src/session/tool-batch.ts:1348-1352` — `admitCompleteBatch` is the only accepted path, yet the kernel legitimately returns a single-call admission for a one-effect batch.
- **Change:** treat a kernel admission whose single lease-row `callID` equals the batch's only member as the complete-batch path; every other shape keeps failing closed through the existing `denyAndCancel`.
- **Verify (≤10 min):** `cd packages/opencode && bun test test/session/tool-batch.test.ts 2>&1 | tail -3`, plus one `bash` call in a live `serve` confirming the denial string is absent.

### 3.4 Fix edit's double-prepare lease mismatch (not in the brief) — 2/15 edits denied

- **Why it moves the numbers:** 13% of edits died at the guarded-set comparison; each denial costs a full re-read and re-emit of the file content (~1–2k output tokens) plus a model turn.
- **File:** `packages/opencode/src/tool/edit.ts:206-219` — `prepareEditBatch` runs before the per-file semaphore and again inside it, then compares `JSON.stringify` against `ctx.extra.guardedPatch`.
- **Change:** compare a digest of the prepared `PatchOperation[]` instead of the JSON text, and on mismatch return a typed `stale_edit` result carrying the current line span for one retry instead of a hard throw.
- **Verify (≤10 min):** `cd packages/opencode && bun test test/tool/edit.test.ts 2>&1 | tail -3`.

### 3.5 Bind "done" to the task's labelled tests (not in the brief; item 8's minimal form) — 1 of the 2 unsolved runs

- **Why it moves the numbers:** 13410 made one edit, ran 11 bash calls, then ran a hand-written `lock()` script that printed `All ad-hoc checks passed!` and stopped with FAIL_TO_PASS 0/2. Nothing in the product distinguishes "my script passed" from "the labelled tests pass"; that distinction is worth more than items 1, 3b, 4, 5, 6, 7 and 10 combined on this evidence.
- **Files:** new `packages/opencode/src/tool/verify.ts` with capability `terminal.run` (same lease path as `packages/opencode/src/tool/shell.ts:60-75`), registered at `registry.ts:248`; label set read from run metadata the harness already writes (`.tmp/nemotron-bench/logs/*/session.json`).
- **Change:** return `{label, status: passed|failed|missing}` per FAIL_TO_PASS/PASS_TO_PASS and refuse to report success when any label is `missing` — the same three-bucket split HANDOFF landed at 13:15.
- **Verify (≤10 min):** `cd packages/opencode && bun test test/tool/verify.test.ts 2>&1 | tail -3` (fixtures: all-pass, one-fail, one-missing).

## 4. POST-RELEASE, grouped by theme, ordered by risk of shipping without it

**Theme A — verification trust.** Shipping without these means "verified" is a model self-report, which AGENTS.md §10 forbids.

1. **Signed `VerificationReceipt` (8b).** No merkle, no receipt type anywhere; only effect receipts exist (`kernel/src/managed_control.rs:19319`). Bind merkle(diff) + diagnostics count + exact command + exit code + stdout digest, and make the release gate accept nothing else as success.
2. **Anti-cheat AST structural diff (8a).** The only tamper check lives in the benchmark script (`scripts/e2e/nemotron-bench.sh:1155-1172`); reject deleted tests, weakened asserts and new `@ts-ignore` / `#[ignore]` inside the Guard path, not in an eval shell.
3. **Label→runner resolution inside the product.** 15–61 PASS_TO_PASS labels per task are unrunnable; the `missing` bucket exists only in the harness. Until the product can say "3 labels could not be resolved", a partial run is indistinguishable from a pass.

**Theme B — capability truth.** Shipping either of the first two as a feature is worse than not shipping it.

4. **LSP + symbol surface (7, 3b).** `lsp/launch.ts:37-39` and `:42-44` both return `false`, so the tool is never exposed; `indexd/src/repo_intel.rs:93-100` answers symbol queries with `UnsupportedOperation`. Shadow-workspace validation is not buildable until a language service can launch — and with 0 regressions measured it is not the current bottleneck either.
5. **Hashline anchors (1a).** `read.ts:349` plus the four-replacer chain at `edit.ts:801-832` are sound today (0 anchor misses in 15 edits); the win is a scale bet on unfamiliar code, so build it post-release behind the already-declared `hashline_edit` descriptor (`feature-exposure.ts:278`).
6. **`assert_seen_lines` (1b).** `edit.txt:4` claims read-before-edit is enforced and nothing enforces it. A 40-line correctness fix, not an architecture project — but it changes no number on today's evidence, so it is not a hackathon item.

**Theme C — context and cost engineering.**

7. **Fold big tool outputs at ingestion, not at compaction (6).** Folding exists only inside compaction (`compaction.ts:39,61`) and no compaction fired in six runs (auto trigger is overflow-only, `overflow.ts:26-35`). At 164k-input runs the first overflow will compact a prefix the provider has already cached — the one place the brief's cache instinct is genuinely right.
8. **Tool router (4).** ~25 schemas per request (`registry.ts:248-283`), no meta-tool. Low value while the schemas sit in the cached prefix; do it when MCP servers multiply the count.
9. **Role-based tiered routing (9b).** No planner/explorer/patchApplier roles exist; the bench pins one model. Worth an eval once a reasoning-model column exists, not an architecture change now.

## 5. IGNORE

- **Item 10 (hindsight store, ε-greedy router):** 6 trajectories, 2 failure modes, no `tokens_per_verified_patch` metric. A router fitted to this is noise; revisit at ≥200 verified runs.
- **Item 5's layout engine:** the substrate already exists (SystemContext deltas, durable epochs, `prompt_cache_key`, `cache_control`/`cachePoint`, nonzero cache reads in real runs). Delete the one non-deterministic line (`system.ts:84`); do not build a BTreeMap/serialization project on top of an already-cached prefix.
- **Item 6's `/compact` `/trim` `/prune` rewrite:** they exist and never fired (`context-ops.ts:128,180`, `compaction.ts:424`). Rewriting the one subsystem with no measured problem is pure churn.
- **Item 4 and item 7 as hackathon work:** one is prefix-token polish, the other is blocked behind a disabled language-service route.

## 6. Three things the brief missed that this repo needs more

1. **Dead fail-closed gates are the defect, not missing efficiency.** 91% of tool errors (32/35) come from three 15–80 LOC defects. Returning `false` until the Guard owner lands is right for safety, but ruinous when the leaf tool has no in-process fallback — grep/glob had a working in-process backend compiled in (`search.ts:129-236`) and still shipped a dead front door.
2. **Verification substitution — the model grading itself.** 13410: one edit, a self-written script, `All ad-hoc checks passed!`, stop, 0/2 FAIL_TO_PASS. Item 8 is the right instinct at the wrong scope: a signed receipt that nothing consumes changes nothing. What the loop needed was a tool that runs the *labelled* tests and refuses `missing`.
3. **Shell and environment hygiene as a first-class cost.** 316 noise lines, a broken `HOME` (`/.cargo/env`), and a model hand-exporting `PYTHONPATH=` in 13410 are all the execution host leaking its own environment into the model's context. `terminal_preview` head-cuts at 50 KB/2000 lines with no ANSI strip and no tail retention (`host_kernel.rs:36253-36275`), so a long failing test run can lose exactly the summary line that matters.
