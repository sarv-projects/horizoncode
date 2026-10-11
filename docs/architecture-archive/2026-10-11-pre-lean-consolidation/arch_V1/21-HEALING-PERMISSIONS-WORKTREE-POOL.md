# HEALING PERMISSIONS WORKTREE POOL — canonical v2 integration

> **Current repository binding (2026-10-10):** Permission states are ask/safe_auto/yolo_sandbox; no silent model fallback; three-dimensional workspace isolation covers source + process/ports + test DB. User-owned dirty work is never pool garbage.

## Imported v2 architectural basis

# 11 — Reliability: four-tier healing, permissions, pooled workspaces, routing and completion

## 11.1 Review of the supplied four-tier self-healing hypothesis

**Source of design:** the four levels in the user's message are a proposed architecture, NOT a verified implementation of Claude Code. Do not attribute a specific SHA-256 error clustering, EWMA, deterministic fallback waterfall, or self-modifying policy to Anthropic absent authoritative source. Source-grounded inspiration: public Claude Code docs describe memory, hooks, skills and permissions. Their memory is advisory context, not execution enforcement.

The four levels should be **orthogonal strategies governed by one coordinator** rather than a literal always-executed cascade: syntax failure goes L1; 429 goes L2; repeated resolved defect contributes an L3 candidate asynchronously; proposed heuristic config changes require L4 testing; *policy privilege changes are never self-applied.*

### L1: deterministic and cheap application-level repair

`FailureNormalizer.normalize(diagnostic)` -> canonical `{kind, tool, code, fileRelative, symbol?, normalizedStack, buildFingerprint, revision, environment}`. Strip volatile timestamps/paths and PII before hashing; `signature = sha256(canonicalJson(stableFields))`. Preserve original logs in restricted artifacts. Same signature **twice in three attempts** is an escalation *signal*, not unconditional proof of a loop: only escalate when no new file/content hash, test observation or resolution evidence has appeared.

`PreflightPipeline.run(stage)` -> file patch syntax validation; parsed syntax via installed compiler/parser or tree-sitter; formatter dry run; relevant LSP diagnostics; impacted lint/check; targeted tests. Never use AST correctness as a substitute for runtime correctness; parsers often accept semantically wrong code. Apply mechanical fixes (formatter, safe import organizing) only if deterministic AND allowlisted. Ambiguous diagnostic -> make small context bundle for **user-selected model**, not assumed cheap different model.

`PatchCheckpoint.create()` stores `{baseRevision, stagedPatchDigest, previousGreenDigest, touchedHashes, acceptedCriterionIds}` in CAS. `rollbackFailedPatch()` may discard only a staged/owned patch if no newer user modifications; otherwise quarantine and propose 3-way reverse patch. Git *virtual trees* are valid for staging, but cannot reliably undo external DB calls, commands or deployed code. Never `git reset --hard` against user's working state.

`NoProgressDetector.observe(step)` uses weighted evidence: verified criterion improvement, changed relevant symbols/files, removed blocker, novel diagnostic or resolved error count. Rolling repeated-hash threshold, time deadline, tool-call count and user cap; classify `repeat_same_plan`, `no_new_evidence`, `over_budget`, `different_failure`, `working`. Do not stop useful retries simply because a stack trace signature repeats while affected state improves.

### L2: provider and infrastructure availability

`ProviderCircuitBreaker`: per **endpoint + model + auth-profile** `{CLOSED,OPEN,HALF_OPEN}`. Record retryable 429/5xx/timeout separately from bad API key, invalid schema, context overflow, safety rejection, malformed tool response, and user cancellation. Only repeat idempotent inference calls when client has proved prior response was not committed or can reconcile provider request ID. Stream interruptions may have billable tokens and partial text—retain partial receipt and mark usage `unknown` if not provided.

EWMA for latency/error-rate: `s_t = α*x_t + (1-α)*s_(t-1)`; minimum sample count, cold-start baseline and breaker cooldown required. Separate input-length/streaming-mode buckets to avoid penalizing slow but normal local models. `OPEN` means unavailable at that endpoint; automatic retries of SAME selected model can occur with capped exponential backoff and jitter, but **model/provider switching requires explicit per-profile user opt-in**. The default is NO cross-model fallback. An explicitly configured fallback list can require `ask` before switching; show likely cost, data locality and output fidelity impacts.

### L3: empirical learner, optional local-first

`OutcomeMiner` records `ErrorSignature`, candidate resolution, repo/framework version, attempts, tests and failure rate. Only evidence-confirmed successful repairs enter `ResolutionPatternStore`. Deduplicate and keep confidence/provenance; avoid storing secret-bearing log strings. Project-specific facts outrank generalized similarity. Retrieval supplies a *suggestion* to the selected model, never a privileged tool directive. User can disable history learning and delete derived entries. Memory retention configurable by record count/bytes/TTL; do not blindly prune all records at 30 days when pinned project knowledge is still relevant.

`ModelQualityEstimator` records context-size bucket, output truncation, format failures, tool schema error rate, time to first token, throughput and success **with sample sizes**. Do not assert e.g. “60% drop rate at 14k tokens” until supported by a statistically useful local sample. It may recommend a shorter context or compatibility harness, but may NOT silently change model.

### L4: sandboxed adaptive changes

`HealingCandidate` has `{category:prompt_template|tool_hint|harness_decoder|diagnostic_rule|timeout_recommendation, diff, evidence, origin, scope, experimentId, decision}`. **Policy rules, allowed paths, elevated privileges, secret access, deployment approvals and sandbox strength are excluded** from automatic promotion. `CanaryEvaluator` runs against immutable benchmark fixtures and optional live *shadow* runs with no privileged write authority; compare false complete, regression, latency and measured consumption. `PromotionGate` requires configured evaluation coverage, minimum samples, no security regression, and human approval for any change affecting operations. Rollback candidate on worse metrics, retain provenance.

### Healing coordinator pseudocode

```text
onFailure(ctx, err):
  cause = normalize(err); persist FailureObserved(cause)
  if cause.kind in {policy_denied, invalid_user_scope, uncertain_external_effect}:
      pause_or_block_with_explanation(); return
  if cause.kind in {syntax, lint, deterministic_patch, test_failure}:
      if safe_known_recipe(cause) and can_prove_scope():
          staged = repair_in_owned_overlay(cause)
          if verify(staged): accept_staged_only(); return
      if no_progress_detected(): change_approach_or_request_user(); return
      schedule_bounded_repair_on_same_selected_model(); return
  if cause.kind in {rate_limited, endpoint_down, timeout}:
      update_breaker(); if safe_retry_selected_model(): retry_with_jitter()
      else pause_and_offer_manual_provider_choice(); return
  if cause.kind in {context_overflow, malformed_tool}:
      preserve_goal_and_evidence(); compact_or_change_harness_with_user_policy(); retry_bound(); return
  if cause.kind == workspace_conflict: quarantine_stale_worker_and_integrate(); return
  record_unknown(); show_actionable_error(); do_not_fake_completion()
```

## 11.2 Model and harness policy: no forced automatic routing

Settings modes:
- `pinned`: exactly one selected provider/model/harness. **Default**. Same-endpoint retries allowed according to budget.
- `manual-fallback`: when unavailable, UI displays explicit comparable choices; execution PAUSES. Never route without acceptance.
- `user-defined-fallback`: optional ordered list of approved pairs `{provider,model,harness,authorization,dataLocality,costCeiling}`; may switch ONLY when profile explicitly allows that trigger. No global AI-chosen ranking.
- `offline-only`: network egress blocked for model/agent tasks and relevant extensions; only reachable local endpoints permitted.

The scheduler may choose which *already configured agent profile* executes a task if the user selected delegation, but this is NOT automatic model routing. If a subagent profile points to a different model, display it in task creation/agent settings, inherit cost/data policy and never surprise-switch the main profile.

`ModelSelectionChanged` must not rewrite existing Run configuration silently. Resume/new attempt snapshots new selection and records a provenance link; provider-native reasoning metadata may be incompatible across model switches, so don't replay opaque metadata blindly.

## 11.3 Permission modes without repeated prompts

| Mode | Behavior | Strict limits |
|---|---|---|
| `ask` | Interactive approval for non-read effects; support allow-once and scoped grant for task/session/project | deny out-of-scope and secret access, never invisible |
| `safe-auto` | Pre-authorize bounded known-safe reads, test/lint, owned temporary writes and reversible scoped source patches | escalating effects, production changes, outside-root writes and destructive operations require approval |
| `yolo-in-sandbox` | Skip *repetitive* prompts for in-sandbox developer actions within explicitly selected disposable workspace | MUST enforce sandbox policy, path/egress/secret confinement, resource budget, deny outside boundary; never equivalent to OS-wide root/superuser privileges |

Keep grant semantics `{effectType,rootGlobs,commands?,networkOrigins?,environment,principal,runId?,maxUses,expiresAt,riskCeiling,revocable}`. Permission precedence deny > organizational restrictions > project restrictions > explicit user grant > mode defaults. `ApprovalCacheKey = hash(principal, tool, actionTemplate, canonicalRoot, environment, riskClass, policyVersion)`, not just command name. Provide quick `Allow once`, `Allow for this task`, `Allow within project`, `Deny`, `View impact`, and `Revoke` in UI. Avoid thousands of approvals by grouping low-risk operations under a short-lived scoped lease, but show a visible audit feed. `YOLO` label MUST explain residual unsandboxed risk if strict confinement is unavailable; do not silently downgrade security.

## 11.4 Multi-agent coordination model

A task is eligible for parallelization when writes/resources are independent OR explicitly isolated. The conflict graph includes `{pathGlobs, repoRevision, exportedAPIs, ports, writableCaches, databases, runningServices, secretsRefs, browserProfiles, publishTargets, sharedFiles}`. Treat unknown predicted write sets conservatively; dynamically detect write/write conflict at effect broker when two workers touch the same revision. Scheduler estimates `parallelBenefit = sequentialCriticalPath - predictedParallelCriticalPath - setupCost - integrationCost - reworkRisk`. Only positive-benefit groups recommended; explicit user override cannot violate safety resource constraints.

**Worker allocator:** `capacity`, `queue`, `fairness`, `maxConcurrentByProject`, `maxConcurrentByProvider`, `maxConcurrentByUser`, `agentCapabilities`. Prefer warm worker/process reuse where isolation permits, not arbitrary creation. When a worker crashes, lease fencing ensures no stale writes. Subagents return typed `ArtifactRef`, `EvidenceRef`, `PatchRef`, `BlockingQuestion`, `ResourceReceipt`, not prose alone. A parent task waits for each child result's accepted outcome or safely handles partial results.

## 11.5 Reusable bounded worktree pool — exact algorithm

Pool states: `CREATING`, `WARM_IDLE`, `LEASED`, `DIRTY_RECOVERABLE`, `QUARANTINED`, `RECLAIMING`, `DELETED`. Defaults suggested (configurable): `max_active=4`, `max_warm_idle=2`, `min_warm_idle=0`, idle TTL `20m`, total disk soft cap `5GiB` dedicated worktree data excluding shared read-only cache; numbers are product hypotheses, not universal constants.

Acquire:
1. lock pool project; reconcile exited PID/process-group and lease fence;
2. choose `WARM_IDLE` whose repository ID/config/toolchain/base commit match and whose clean Git index/working tree AND untracked files verification pass;
3. if none, and active+creating below caps and sufficient disk/inode budget, create linked worktree on unique internal branch/ref; otherwise queue;
4. allocate port, test DB namespace, writable build/output cache and browser profile as **a single reservation manifest**. Roll back partially allocated resources on failure;
5. bind `{taskId, attemptId, workerId, resourceId, epoch, leaseTTL, baseRevision, ownerUid}` and issue short-lived grant;
6. assign to agent; ensure every tool call checks current fence.

Release:
1. fence old execution and stop attached process tree; wait for child cleanup and open-handle stabilization;
2. gather Git dirty/untracked report and staged patch effects; preserve unmerged data and checkpoint artifacts;
3. integration work happens on staging branch with three-way merge; run final integrated verification; do not modify user's branch until user policy allows;
4. if all changes integrated/archived, strip task-generated directories and reset only **owned** worktree to prepared base; validate clean state and safe reference, transition `WARM_IDLE`;
5. if unknown writes/processes/dirty patches remain -> `QUARANTINED`, not idle reuse; show recover/review/discard options;
6. periodically retain up to `max_warm_idle`, reclaim clean idle after TTL/disk pressure; Git prune only after OS process and worktree metadata check.

Heartbeats must not be sole cleanup authority (worker crash, machine crash); use startup recovery scan. Do not delete an entire worktree because a job finished if a dirty user change, unmerged agent result, or active child PID remains. Build caches shared read-only keyed by toolchain+lockfile; writable target/build dirs isolated with explicit eviction policy. Track disk use, inode use, clean/dirty state, lease epoch, reuse count, last verified base and cleanup outcomes.

## 11.6 Parallel integration and retry

Parallel agent tasks operate on pinned base snapshots; their proposed artifacts are merged into a fresh integration tree in dependency order. An API contract change can invalidate downstream tasks. On conflict, first use deterministic Git 3-way resolution only for provably independent hunks; otherwise invoke selected model on minimal conflict with both task intents and evidence. After merge, run cross-task checks and re-evaluate the whole goal. A successful subtask verification on earlier branch is stale for final integrated revision unless evidence explicitly remains valid.

## 11.7 Durable goal based on Codex observations, strengthened

`Goal` is a user-owned objective and `GoalRevision` immutable criteria; `Run` executes a version. `/goal` shows objective, status, criteria coverage, pending tasks, budget/time, open questions and evidence. `/goal edit` creates new revision and invalidates affected work. `/goal pause`, `/goal resume`, `/goal clear` have explicit semantics. Agent may call `propose_goal_complete(evidenceRefs)`, `report_goal_blocked(reason)` or `get_goal` but **NOT** `finalize_run` directly. Goal completion gate checks all mandatory criteria against final integrated revision, resolved effects, policy and no active workers. `goal complete` is derived from a successful Run, not a model signal. If user edits a goal while active, do not continue on obsolete approved scope.

## 11.8 Critical invariants and recovery

- No `GoalCompleted` without authoritative verification receipt and final integrated revision.
- No effect after fence changes. Stale output can be preserved as artifact but NEVER applied.
- No automatic paid-model switch or external-data transfer under pinned model.
- No `WARM_IDLE` worktree with untracked writes or running processes.
- No `yolo-in-sandbox` effect outside enforced sandbox. Refuse / ask for lower mode if sandbox unavailable.
- No unbounded retries without measurable progress, current user budget, or explicit continuation consent.
- No silent deletion of user modifications; quarantine is always preferred to destructive cleanup.
- No agent-generated healing proposal can widen OS privileges, alter security policy or enable network egress automatically.
- A provider timeout does not imply its request cost was zero, and an external tool timeout does not prove the effect did not happen.


---


## 11.9 2026-10-11 learning boundary and analytics-first recovery

The four-tier recovery design is narrowed for V1:

- **L1 deterministic repair** remains V1: syntax/parser/linter/test-directed local diagnosis,
  reversible rollback and exact no-progress detection.
- **L2 provider/runtime recovery** remains V1: same explicitly selected route, bounded retry,
  breaker/health telemetry and visible paused/block states. It does not choose another model.
- **L3 empirical knowledge** in V1 is **reviewed/advisory retrieval only**. Store
  provenance-bearing failure→successful-strategy observations and statistics; retrieval may
  suggest a strategy but cannot authorize or automatically mutate global behavior.
- **L4 meta-configuration/self-tuning is post-V1 experimental**. Candidate prompt/profile/
  harness/config changes may be generated and sandbox-benchmarked only under an explicit
  experiment. Promotion requires human/admin approval and can never widen Guard policy,
  silently change provider/model, self-install extensions or rewrite architecture authority.

V1 therefore prioritizes deep operational analytics (§31): normalized failures, strategy
attempts, state deltas, token/cost/cache/latency, tool success, recovery time and regression
outcomes. This provides the data needed for later experiments without making the shipping
agent self-modifying.

Any learned record is advisory memory, not a Hook, rule, permission, verification result or
completion fact.
