# Long-horizon coding agent: research synthesis

> INTERNAL RESEARCH — prepared at the user's request on 2026-09-27. This is a proposed design, not an implemented or benchmark-proven architecture. It is not a shipped product claim.

## Executive summary

Long-running coding work needs a durable control plane around the model. Keep four responsibilities separate:

1. Intent and specification record what the user means and what counts as success.
2. The execution controller owns state transitions, budgets, retries, policy, and stop decisions.
3. Workers propose plans and perform bounded coding or review tasks in isolated workspaces.
4. Independent verification checks code against the specification and the user's confirmed outcome.

Conversation history is not a database, and an agent's statement is not proof. Persist a versioned task graph, decisions, workspace revisions, effect receipts, verification evidence, and external-agent references. A task is complete only when evidence is tied to both the tested code revision and the approved specification version.

This combines public long-running-agent research with HorizonCode's stated control-plane design. The cited research shows approaches that were tried; it does not establish that one universal architecture is best.

## Evidence and claim limits

| Evidence | What it supports | What it does not prove |
|---|---|---|
| Anthropic's [long-running agent harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) (2025-11) describes initializer/coder separation, feature tracking, progress files, initialization scripts, and Git checkpoints. | Incremental tasks and explicit handoffs can address lost context and poor session continuity. | That a progress file or a particular agent split is sufficient for reliable completion. |
| Anthropic's [planner/generator/evaluator study](https://www.anthropic.com/engineering/harness-design-long-running-apps) (2026-03) explores multi-hour work and evaluator separation. | Separate evaluation and end-to-end app checks are useful experiments. | That the evaluator is error-free or generalizes to every model, repository, or task type. |
| Anthropic's [managed-agent architecture](https://www.anthropic.com/engineering/managed-agents) (2026-04) describes harness, sandbox, and append-only session history as separate primitives. | Runtime state, execution isolation, and model reasoning are separable concerns. | A complete public schema or universal production blueprint. |
| The [ACP changelog](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/CHANGELOG.md) reports stable v1.9.1 on 2026-09-18; v2 changes remain marked unstable. | Negotiate capabilities and keep a v1 path while v2 evolves. | ACP provides a task DAG, budgets, durable task state, or verification. |
| HorizonCode [architecture](ARCH/03-ARCHITECTURE.md), [session model](ARCH/07-SESSION.md), [loop](ARCH/08-LOOP.md), [orchestration](ARCH/16-ORCH.md), and [verification design](ARCH/23-VERIFICATION.md). | The design calls for durable sessions, a task graph, bounded receipts, policy separation, and evidence gates. | That each described component is implemented or accepted. |

## Proposed high-level architecture

    User surfaces: CLI, TUI, IDE, API, ACP
                         │
    Intent validation and versioned specification
                         │
    Deterministic execution controller ◄────► Durable run state and event log
          │              │                         │
          ▼              ▼                         ▼
    Repository map   Task graph/scheduler     Artifacts and evidence
          │              │
          └──────────────┤
                         ▼
    Agent adapters → isolated worktrees → guarded tool execution
                         │
                         ▼
    Independent code, integration, intent, and acceptance evaluation
                         │
                         ▼
    Integration, PR preparation, authorized delivery

All stages read and write durable state through controlled interfaces. The controller should use deterministic code for state, budget, lease, policy, and retry decisions. Use models where judgment or language understanding is required; persist their proposals and evidence.

## Lifecycle and state ownership

Run and task state are separate. A run can wait while tasks are blocked, or continue while one independent task has failed.

**Run lifecycle:** DISCOVERING → INTENT_VALIDATING → SPECIFYING → PLANNING → EXECUTING → INTEGRATING → VERIFYING → AWAITING_ACCEPTANCE → COMPLETED.

At any active stage, the controller may enter RECOVERING, WAITING, CANCELLED, or STOPPED. COMPLETED requires positive evidence. STOPPED means policy, cancellation, deadline, or budget ended the run without implying success. WAITING names the missing decision or dependency.

**Task lifecycle:** BLOCKED → READY → CLAIMED → RUNNING → VERIFYING → PASSED. Other explicit states: FAILED, WAITING_FOR_USER, WAITING_FOR_EXTERNAL, NEEDS_REVIEW, CANCELLED, SUPERSEDED. A dependency unlocks only from PASSED with evidence matching the current specification and integration revision.

State mutation rules:

- The controller owns transitions; workers return proposals and receipts.
- A transition is transactional with its event and evidence references.
- Retry counts and consumed budget survive restarts and model/session replacement.
- A specification revision invalidates affected tasks and verification by dependency.
- Completion is derived from required criteria and evidence, never a free-form worker claim.

## Durable record model

These are recommended logical schemas. Concrete SQL migrations, event serialization, and protocol contracts remain implementation work.

| Record | Minimum durable fields |
|---|---|
| Run | Run ID, original-request reference/hash, repository identity, starting and integration commits, state, specification version, policy/config snapshots, resource ceiling/reserved/spent, owner lease, terminal reason, timestamps. |
| IntentBundle | Original request, confirmed goals, constraints, examples, unresolved questions, assumptions with owner/expiry/impact, decisions with source, clarification references. |
| SpecificationVersion | Immutable spec ID/version/parent, requirement IDs, contracts/invariants, acceptance examples, exclusions, decision refs, approver/time, content digest. |
| Task | Task/run/spec IDs, goal, deliverable, acceptance criteria, dependencies, status, priority, worker/adapter, permission ceiling, workspace ref, attempt count, budget ceiling/spend, input/output artifact refs, verifier refs, lease/timestamps. |
| Attempt | Attempt/task IDs, strategy/model/adapter, prompt/spec digest, workspace base revision, environment, start/end, outcome, diagnostics, usage provenance, retry classification, progress signature. |
| ExternalAttempt | Stable external-attempt ID, parent run/task/attempt, peer and executable/endpoint identity, protocol/version/capability snapshot, external session/thread ID, worktree/base commit, requested scope, permission snapshot, lease, lifecycle status, last event cursor, cancel state, timestamps, usage provenance, receipt/artifact refs, resumability and opaque-state flags. |
| EffectReceipt | Idempotency key, action kind/resource, request digest, authorization decision/ticket, started/completed/unknown state, provider receipt, reconciliation result, compensation reference. |
| Evidence | Immutable ID, evidence kind, producer/version, command/scenario, result, artifact digest, repository commit, specification version, platform/environment, timestamp, confidence and coverage. |
| Decision | Question, alternatives, answer, rationale, evidence, user-confirmed flag, affected tasks/specs, supersedes link. |
| Event | Event ID, aggregate ID/type, sequence, schema version, timestamp, actor, causation/correlation IDs, payload, previous digest; large output is an artifact reference. |
| Workspace | Worktree ID/path, repository identity, base/head revisions, lease, writer, status, integration result, cleanup state. |

Keep large stdout, traces, binaries, and patches in a content-addressed artifact store; relational records keep typed references and hashes. Events preserve history; indexed projections make scheduler queries fast. Define one canonical owner for task-graph truth so session logs and database projections cannot disagree.

## Intent-validated specification workflow

SDD must detect a correct implementation of a misread request. Keep the original request intact and preserve uncertainty instead of turning assumptions into requirements.

1. Discover the repository, goal, constraints, dependencies, and affected workflows. Attach file and commit evidence.
2. Clarify only questions whose answers could change behavior, safety, migration, or scope. Store answers as user-originated decisions.
3. Specify observable requirements, examples, invariants, API/data contracts, exclusions, migration/rollback, and acceptance tests.
4. Validate contradictions, coverage, source traceability, and consistency between requirements, examples, and task graph. Allow INSUFFICIENT_EVIDENCE.
5. Bind every task to specification IDs and acceptance criteria; enforce dependencies in the scheduler.
6. Let implementation discover facts. A technical decision can change design; a user-visible behavior change creates a new spec version and replans affected tasks.
7. Evaluate implementation against the approved spec and separately evaluate scenarios against the user's confirmed outcome. The evaluator can return missing evidence or ambiguous intent.
8. Separate user acceptance from automated test passage. Record authorized release actions and post-release outcome evidence.

Requirement categories: CONFIRMED, ASSUMPTION, TECHNICAL_DECISION, PROPOSED_CHANGE, EXCLUSION. Each carries provenance. A proposed change to user-visible behavior waits for the user unless policy explicitly delegates that authority.

## Execution, recovery, and stopping

Before dispatch, reserve resources for the worker plus mandatory verification and recovery. Track tokens, spend, tool calls, wall time, context, retries, workspace storage, and provider quota when observable. Keep reported usage separate from estimates and unavailable telemetry.

Recovery is classified, not blindly replayed:

1. Infrastructure: reacquire a run lease; inspect processes and reconcile in-flight effects before retry.
2. Workspace: verify revision and dirty state; restore only to a known checkpoint whose effects are understood.
3. Implementation: preserve failures, make a bounded repair based on new evidence, rerun affected checks.
4. Planning: after repeated failure, compare attempt fingerprints, change decomposition/strategy, or escalate.
5. Intent: suspend affected descendants, reopen clarification/specification, and invalidate evidence tied to the old interpretation.

An attempt fingerprint includes task, spec digest, action class, changed files, test failure signature, environment, and strategy. Repeating the same action with no new evidence is a loop signal. Do not reward tool-call volume, lines of code, or self-reported confidence.

The stop controller chooses CONTINUE, CHANGE_STRATEGY, PAUSE, STOP, or COMPLETE before costly actions and after meaningful results. Completion is evidence-positive; budget exhaustion is not success; no eligible task is not proof of completion. Reserve verification resources before implementation.

## Tracking external agents as subagents

Yes, at the boundary HorizonCode controls. Assign task and attempt IDs before launch. Persist peer identity, negotiated capabilities, session/thread ID, event cursor, workspace/base commit, authorization scope, and lifecycle. Normalize only events the peer actually emits: start, plan/progress, tools, permission, input, artifacts/diff, completion, failure, disconnect, cancel, and resume. Save raw protocol payloads as bounded artifacts; canonical state stays in HorizonCode.

| Peer shape | What HorizonCode can track | Boundary |
|---|---|---|
| Native worker controlled by HorizonCode | Task, turn, tool, budget, workspace, and verifier state. | Validate effects and results independently. |
| ACP peer | Negotiated methods, session IDs, streamed updates, tool lifecycle when sent, permissions, cancel, and load/resume if advertised. | ACP is not a universal durable DAG or usage schema. |
| App-server peer | Thread/turn IDs, item/agent status and notifications exposed by that version. | Pin schema/version; optional methods change. |
| One-shot CLI subprocess | Start/end, exit status, bounded output, worktree diff, tests run by HorizonCode. | Do not claim internal progress, usage, resume, or nested children unless emitted. |
| Opaque service | Heartbeats and task IDs supplied by its API. | A heartbeat does not prove progress or success. |

Keep protocol-session identity separate from run/task identity. Reconcile workspace and external effects after disconnect before resuming or relaunching. Nested agents are invisible unless the peer reports them. The [Qwen Code external-executor documentation](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/sub-agents.md) gives a concrete example: its ACP-backed peer can retain/continue, while its documented Codex app-server bridge is one-shot and reports neither progress nor cost. Adapter capability metadata should expose this difference.

## Repository intelligence and PR delivery

Build an evidence-backed, commit-bound repository map:

- Discover manifests, entry points, test commands, CI, docs, lockfiles, generated code, and module relationships deterministically.
- Use Tree-sitter definitions/references and ranked symbol/file relations broadly; use LSP/SCIP when available for semantic certainty. Label unresolved edges.
- Record source commit, file digests, parser/index versions, workspace root, ignored/generated rules, and refresh state.
- Give each task source/test pointers and selected excerpts; retrieve more on demand instead of stuffing the full repository into prompts.
- Invalidate context when source digests or base commit changes. A repo map is a navigation aid, not proof.

PR lifecycle: read issue/PR and history; draft spec/examples; implement in a branch/worktree; verify; review diff and unintended files; collect an independent review; create a draft PR only under authorized policy; persist PR ID, branch, commit, checks, reviews, and follow-up state. Merge/deploy is separately authorized. An agent's “green” summary is not PR evidence.

## Local inference is a separate layer

The model server is a replaceable inference backend, not a substitute for authorization, durable state, or verification. API compatibility is a transport claim, not proof of correct structured tool calls.

| Runtime | Strong fit | Cautions |
|---|---|---|
| Ollama | Simple local install/API and single-machine experiments. | OpenAI compatibility is a subset. Check tools, streaming, context, modalities, IDs, and cancellation per model/version. |
| LM Studio | Desktop model management, local API, tool experiments. | Docs distinguish native tool formats from fallback prompt parsing; fallback quality varies. |
| vLLM | GPU-backed shared serving and throughput experiments. | Operator-managed GPU/memory/runtime; configure parser/template and measure exact model path. |
| SGLang | High-throughput serving for supported models. | Feature/model/backend coverage is release-specific. |
| MLX-LM | Local model experiments on supported Apple hardware. | Upstream says basic server security only and not recommended for production; tool calls vary by model/template. |

Primary docs: [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility), [LM Studio APIs](https://lmstudio.ai/docs/developer), [vLLM serve](https://docs.vllm.ai/en/latest/cli/serve/), [SGLang API](https://docs.sglang.ai/basic_usage/openai_api.html), [MLX-LM server](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/SERVER.md). Recheck before implementation; APIs change.

Adapter conformance should cover model discovery, system prompts, JSON/schema mode, tool parsing and malformed arguments, parallel calls, streaming, cancellation, context overflow, token/cache accounting, and retries. Record weights/quantization, server build, template/parser, sampling, and context in each evaluation.

## Findings from the current HorizonCode checkout

Reviewed ARCH/00–23, README, TODO, CURRENT_RUN, and Rust crate inventory. HEAD: **dacca6042e264344b7ec5971f7d131bc36f69d37** (2026-09-27). This is document/source inspection; no tests were run.

**Strong design already present**

- Durable per-session JSONL replay/checkpoints and explicit turn lifecycle in ARCH/07–08.
- Authorization/enforcement separation and per-tier guarantees in ARCH/12–13.
- Both ACP directions, child sessions, bounded receipts, task DAG, budgets, worktrees, and merge arbitration in ARCH/15–16.
- Evidence-bound acceptance, determinism, repeat, and honest claims in ARCH/23.
- OpenCode's models.dev catalog is selected as provider/model data in DEC-021; this does not mean adopting its runtime.

**Material gaps and contradictions**

1. **Intent is not a first-class durable object.** Requirements/module maps lack a versioned user-intent, assumption, clarification ledger and separate check against the confirmed outcome.
2. **Task graph owner/schema need one canonical definition.** ARCH/16 specifies a durable DAG; ARCH/07's SQLite tables and events do not define task nodes, edges, attempts, leases, external effects, or task-graph versioning/transactions.
3. **External attempt receipts are underspecified.** Subagent refs/receipts need protocol/capability snapshot, adapter session ID, resumability, progress cursor, exact workspace commit, cancellation reconciliation, usage provenance, and nested-agent limits.
4. **Verification needs a separate intent evaluator.** ARCH/23 is rigorous on project evidence and release gates; it does not define independent user-outcome scenarios or a verifier that may return insufficient evidence.
5. **Crash consistency for side effects needs a concrete contract.** Specify action journaling and idempotent reconciliation for commands, PR creation, crashes, and unknown outcomes.
6. **Repository documentation is stale.** TODO cites evidence at aee1e0b; checkout HEAD is dacca604. TODO calls audit and analytics absent/not started although HEAD tracks horizoncode-audit and horizoncode-analytics; README repeats old P0/P1 status. Reconcile tracker, code, executable evidence, and acceptance before claiming readiness. A crate's presence is not acceptance.
7. **Protocol evolution needs a schema pin.** Store peer protocol/capability snapshots per attempt. ACP v1.9.1 is stable; some v2 changes remain unstable.
8. **Stop/recovery policy needs a proved controller.** Persist retry ceilings across restarts, resource reservations including verification/recovery, leases, attempt fingerprints, and distinct WAITING/STOPPED/COMPLETED states.
9. **Evaluation must precede gated features.** ARCH/23 says this; TODO says AX-307 is not started. Repo ranking, compression, routing, and model selection need paired task-level measures first.
10. **Specific defects/platform evidence remain open in the tracker.** TODO identifies patch atomicity, missing sandbox acceptance on target platforms, and path extraction/TOCTOU concerns. Not revalidated here; reconcile TODO with current source/tests.

## Evaluation plan

Compare the same tasks against a one-agent baseline with identical model, context, permissions, and spend cap. Split by repository/language/task type and keep hidden scenarios.

| Metric | Definition |
|---|---|
| Verified completion | Mandatory acceptance scenarios pass on final integrated commit and current spec. |
| Intent mismatch | Delivery conflicts with confirmed goal, constraint, or exclusion. |
| Regression | Previously passing behavior breaks in the integrated change. |
| Recovery success | Restart/crash/cancel reconciles state safely without duplicate effects. |
| Premature completion | Controller completes without required evidence or user acceptance. |
| Correct stop | Pause/stop when no justified action remains; continue only with justified work and verifier budget. |
| Duplicate work/cost | Replayed work and actual or clearly estimated spend per verified deliverable. |
| Tracking completeness | Peer lifecycle and workspace/effect evidence linked to attempts; unavailable telemetry stays labeled unknown. |
| Human intervention | Clarifications, approvals, conflict decisions, and manual recovery by risk class. |
| Context quality | Relevant source/test recall, stale-reference rate, token use, comparison to grep/read baseline. |

Inject process kills, malformed protocol events, timeouts, concurrent worktree edits, spec changes, and failed verification. Evaluators are fallible too: combine deterministic checks, hidden scenarios, independent review, and human checks for consequential decisions.

## References

- [ACP changelog](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/CHANGELOG.md)
- HorizonCode: [architecture index](ARCH/00-INDEX.md), [requirements](ARCH/02-REQUIREMENTS.md), [architecture](ARCH/03-ARCHITECTURE.md), [session](ARCH/07-SESSION.md), [loop](ARCH/08-LOOP.md), [orchestration](ARCH/16-ORCH.md), [verification](ARCH/23-VERIFICATION.md)
- Source maps: [OpenCode](opencode.md), [Codex](codex.md), [Cline](cline.md), [Claude Code](claude.md), [Aider](aider.md)
- Additional candidates and inference backends: [research landscape](research-landscape.md)
