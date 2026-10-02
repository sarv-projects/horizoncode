# Historical contract-choice extraction (2026-10-02)

This is a dated audit inventory, not an active proposal list. It intentionally
preserves questions and dispositions captured from earlier architecture drafts,
including items since resolved or superseded by the canonical blueprint. Do not use
it to infer an open implementation decision. `ARCH/` owns the target contract;
`TODO.md` owns delivery status and concrete remaining work. Individual lines below
are retained as historical source material and are not normative.

## 07-SESSION.md: Open questions

1. **Index split — resolved.** One global rebuildable `state.db` indexes Threads; canonical logs/blobs remain per Thread. Index loss degrades search to a truthful rebuild/partial state, not lost history.
2. **Multi-node ownership — deferred.** The per-key coordinator is process-local in v1. A clustered owner using leases/epochs is outside v1; same-Thread single-writer behavior must still be fenced across local processes.
3. **Storage values — selected, validation pending.** `DEC-058` owns the event, segment, Thread artifact, and replay ceilings. They require workload/platform benchmarks before status can become verified. Segment rotation is not pruning; archives do not replace a verified committed head.
4. **Fork boundary — v1 decision.** Fork only at a committed turn boundary. Mid-turn fork requires a separate migration/recovery design; a partial turn is preserved for inspection but cannot be forked as though it had completed.
5. **Injected-context admission.** The exact classification rules for `next-step` injected context versus steered user input, and whether injected context is ever persisted as a user-visible message.
6. **Format-version policy for external agents.** Whether externally produced thread logs may be imported and migrated, or only replayed read-only.
7. **Artifact/storage validation.** Encoded per-object/Thread defaults, decoded media ceiling, event ceilings, and orphan-GC grace are selected in `DEC-058`. The separately protected physical disk reserve and the minimum capacity/profile across supported filesystems still need implementation evidence and laptop/server workload validation. There is no unbounded fallback.

At compaction boundaries, append
`ThreadEvent::CompactionCommitted { epoch_id, summary_artifact_ref, brief_digest }`
with references to the committed summary and the ExecutionBrief used by the new
ContextEpoch. The reference is provenance for prompt reconstruction, not a second
conversation history or plan owner. Run/task truth is re-read from CMP-orch and the
canonical run stream; the recipient Thread inbox continues to store only references to
untrusted agent messages (ARCH/product/AGENT-MESSAGING.md).

## 08-LOOP.md: Open questions

1. **Stuck-detector definition.** Whether "no progress" is repeated identical tool calls, unchanged workspace hash, or both; the exact threshold and the escalation primitive are not yet fixed.
2. **Retry policy values.** Maximum strategy changes and repair attempts by execution class remain to be selected and benchmarked; the durable Attempt count and spend do not reset when a new Thread/WorkerExecution is created.
3. **Verification depth in the loop.** Which success conditions require executable verification versus model attestation, and how a failed verification reopens the task graph.
4. **Barrier declaration surface.** Whether ordering barriers are declared by the tool author, the model, or the runtime from write-scope analysis; the reference sources imply but do not settle this.
5. **Partial-marker semantics.** Whether a `partial` step auto-resumes on the next user input or requires explicit confirmation, and how it interacts with budgets.
6. **Pre-step compaction vs post-overflow.** Whether a single compaction policy can serve both the proactive budget check and the reactive overflow path without double-summarizing.

The native Runner remains one bounded HorizonCode model/tool step loop. External worker
adapters own their own loop; CMP-orch schedules and observes those WorkerExecutions
through WorkerAdapter and CMP-execution-host rather than nesting another native loop
around them. Context-pressure notification happens before dispatch; the context owner
reserves handoff capacity before tool admission. Worker done/exit remains a candidate
receipt, not task completion (DEC-084, ARCH/execution/ORCHESTRATION.md, ARCH/execution/LONG-HORIZON.md).

## 09-CONTEXT.md: Open questions

1. **Default reserve/tail/summary caps per model class.** The 50% automatic trigger
   is fixed by `DEC-006`; reserve, retained-tail, and summary-cap calibration for
   small local models remains open.
2. **Repo-map budget default and personalization policy.** The token allowance
   and how strongly an active file overrides global centrality are unmeasured.
3. **Tokenizer strategy.** A single conservative estimator vs per-provider
   tokenizers; the drift threshold that forces re-measurement is unspecified.
4. **Index-exchange ingest scope.** Which indexer artifact is consumed, and
   whether it is required or purely an accelerator.
5. **Eval probe set ownership and thresholds.** Who curates the "must survive"
   facts and what regression margin blocks a strategy change.
6. **Embedding/rerank trigger.** The concrete recall metric and threshold that
   would move selection away from its deterministic-first design.

## 10-TOOLS.md: Open questions

1. **`tool.max_steps` default** and whether it is per-turn, per-task, or
   per-agent; and whether the limit scales with budget.
2. **Parallel-safe classification of `task`.** Whether sub-agent spawn is
   parallel-safe (independent worktrees) or always exclusive (shared session).
3. **Managed-output retention ownership — resolved.** `CMP-artifact` owns pins,
   release, and GC; checkpoints/evidence retain every reachable required output.
   See `ARCH/product/ARTIFACTS.md` and the invariant above.
4. **MCP permission-action derivation.** The exact scheme that maps a server+tool
   identity to an allow/ask/deny rule without leaking server specifics into the
   model-visible name.
5. **Structured-output adoption for read/glob/grep.** Which tools benefit from a
   stable structured projection (for UI and eval) versus text only.
6. **Headless question delivery — resolved target.** Use durable `NEEDS_INPUT` when
   the question broker is available; otherwise omit the tool and pause with typed
   `QUESTION_UNSUPPORTED`. Do not synthesize an answer or ask the model to continue.
   Current code remains interactive-only; see the source-status block and AX-380.

## 11-PROVIDER.md: Open questions

1. **Wire-shape naming.** Adapters are named by framing grammar to preserve `DEC-011`; confirm this is acceptable in code identifiers versus assigning neutral protocol ids in the schema. The upstream identity mapping stays in `docs/research/SOURCE-LEDGER.md`.
2. **OAuth registrations.** Each sign-in provider needs its own current documentation, terms, client registration, scope review, and callback/device-flow evidence. Providers needing another application's client identity remain unavailable until a lawful HorizonCode client integration is approved.
3. **Cross-provider failover invalidation.** Resolved by DEC-070: no silent cross-provider failover after exposed content/tool deltas; only the pinned compatible pre-exposure route policy applies. Future mid-stream support needs a separate decision and acceptance.
4. **Tokenizer strategy.** Per-provider exact tokenizers versus one conservative estimate shared with `CMP-context`.
5. **Reasoning partial support.** Whether a model that supports *some* normalized effort levels ignores, maps, or errors on the rest.
6. **Eval suite ownership.** Which suite, who publishes scores, and how the score artifact is signed/versioned is not yet fixed.

## 12-GUARD.md: Open questions

1. **Grant-scope implementation details** — persist `once`, bounded session, or
   project scopes with expiry, exact resource/action, policy/workspace/principal
   binding, and user-visible reason. Product posture is settled in `DEC-075`; data
   schema and expiry/revocation acceptance remain open.
2. **Saved-rule scope key** — project identity vs. workspace path when a repository
   is moved or opened through a symlink.
3. **Catastrophic-gate catalogue** — `DEC-073` and this LLD name minimum destructive
   classes; the complete command/effect catalogue and versioning must be settled
   before implementation. `rm` spelling alone is not a complete semantic classifier.
4. **Wildcard/glob unification** — **Resolved by `DEC-025`:** there is exactly one
   path grammar. `fs.*` resources are matched with the shared path grammar
   (`MatchMode::Path`) and `exec.run` with the raw command matcher
   (`MatchMode::Raw`); the grammar is versioned and the same corpus is replayed
   against `CMP-sandbox` deny globs to assert an identical decision in both layers.
   What remains open is only the exact escape-rule surface (leading `!`/`^`,
   character classes) and how it is versioned alongside the grammar
   (`G-10`).

## 13-SANDBOX.md: Open questions

1. **Windows backend** — the target mechanism (AppContainer + restricted token/job
   objects) is a design option, not shipped support. First prototype the native
   boundary, then pin the exact filesystem, registry, child-process, and network test
   matrix; reject confined execution until that passes (`TODO.md` AX-113).
2. **Once-at-startup vs. per-command wrapping** — confirm the split between the
   process-lifetime in-process confinement and the per-command subprocess view for
   every tool, especially long-lived shells.
3. **Container/remote tier auth** — how a remote sandbox mounts the workspace and
   where credentials come from without leaving `CMP-secrets`.
4. **Deny-glob materialization on Linux** — the fail-closed threshold (file count,
   scan depth) at which a glob makes the profile unstartable.
5. **macOS Seatbelt child-network** — the source renders a network rule, but child
   inheritance, IPC, and helper-process reach must be tested on macOS before deciding
   which guarantee level to advertise. A caller that requires a stronger level is
   refused. See `ARCH/acceptance/ACCEPTANCE-MATRIX.md` ACC-P1-01 and TODO AX-114.

## 14-AUDIT.md: Open questions

1. **Device-key rotation and escrow.** The anchoring *defaults* are resolved by
   `DEC-022`: signing is unconditional, the default level is `local-sink`
   (`offbox: "file"`, a validated sink outside the audit store root), `off-box` is
   required for a deployment that declares an off-box trust requirement, a
   configured-but-unreachable sink fails closed, and `local-trust` survives only as an
   explicit, acknowledged, labeled posture. What remains open is rotation and escrow for
   the device signing key (and the default anchor cadence per deployment).
2. **Retention capacity values** — choose hot-store/archive ceilings and protected
   control/effect reserves from long-run workload and disk-failure benchmarks. The
   behavior is fixed: no destructive prune; archive only sealed, verified ranges with
   retained references; stop new effects before an unrecorded append. Exact values
   remain open until measured.
3. **PII redaction policy** — the exact field allowlist for `meta` and whether
   workspace-relative path normalization is always safe across multi-root workspaces.
4. **Verify performance at scale** — incremental verification from a trusted
   checkpoint versus full-chain recomputation for very long sessions.
5. **Audit of audit** — whether `verify`/`replay`/export operations themselves append
   entries (proposed: yes for export, to record access).

Every managed EffectIntent correlates its stable EffectId to TaskId, AttemptId, and
WorkerExecutionId when applicable. Before invoking a network adapter for an external
side effect (for example PR creation/comment), append the durable PREPARED audit
record and acquire the effect's authorization/idempotency bindings. Missing durable
prepare or unavailable audit capacity blocks invocation. Recovery reconciles the
same identifier and never repeats an unknown external effect based only on a missing
local response (ARCH/execution/LONG-HORIZON.md).

## 15-PROTOCOLS.md: Open questions

1. **ACP client concurrency — open, release-gated.** Owner: `CMP-acp` / `CMP-control-api`. `ACC-P1-05` already forbids silent dual ownership; before multi-client service is enabled, decide whether there is one controller lease with read-only observers or multiple explicitly serialized controllers. Acceptance must prove ownership, answer-origin binding, disconnect behavior, and control-lane responsiveness. Until decided, permit only one controlling connection per Thread and reject competing mutation/control claims.
2. **MCP protocol revision — resolved with ARCH/product/DISCOVERY-AND-EXTENSIONS.md.** Owner: CMP-mcp. Pin the selected released schema and initialized lifecycle; test negotiation, reconnect and incompatible-server refusal. Additional revisions require reviewed compatibility fixtures, not speculative automatic fallback.
3. **Headless exit-code table — open, release-gated.** Owner: `CMP-headless`. Numeric values and whether guarded-deny shares a code must match the actual implementation and `--help`; do not invent values in this target document. `ACC-P1-08` is the acceptance gate and must capture the implemented table.
4. **ACP client authentication — open, release-gated.** Owner: `CMP-acp` with `CMP-secrets` and `CMP-guard`. Before remote peer connections ship, decide and document peer identity/authentication, credential origin, rotation, and authorization scope. Until then, remote connections without an authenticated, authorized peer identity are unavailable; local stdio trust does not imply remote trust. Acceptance must cover wrong identity, missing/expired credentials, and refusal before session creation.
5. **Edge SDK generation and drift — open, release-gated.** Owner: Edge SDK with `CMP-acp`. Decide generated versus hand-maintained bindings against a pinned released schema. Whichever path is chosen must have a reproducible build/schema-diff check and prove the SDK cannot introduce protocol or control-plane behavior absent from the Rust service.
6. **MCP resource/prompt injection budget — open, release-gated.** Owner: `CMP-mcp` for acquisition bounds and `CMP-context` for admission/rendering. Specify per-resource bytes, page/count limits, aggregate token budget, provenance/framing, and behavior on overflow. Until those bounds are configured and tested, do not automatically inject discovered resources/prompts; explicit selection still remains subject to size limits. Acceptance must prove over-limit inputs are omitted atomically with a visible non-authorizing marker and cannot truncate into trusted-looking instructions.

## 18-CONFIG.md: Open questions

1. **`CMP-config` registration.** Resolved: `CMP-config` is registered in `ARCH/03-SYSTEM-ARCHITECTURE.md` §2 (Capability layer). No further `DEC-*` is needed for registration; the extension surfaces it configures remain governed by `DEC-018`.
2. **Memory requirements.** Resolved: memory is covered by `REQ-MEM-001..007` in `ARCH/02-REQUIREMENTS.md` (bounded persistence, attributable/inspectable writes, typed context injection, separate scopes/consent/export/purge, child-context/profile-memory isolation, and canonical project identity). `ARCH/product/MEMORY.md` sets v1 compaction to no automatic summarization or eviction; capacity pressure refuses new writes. Remaining open details are exact per-scope size bounds and disclosed retention/expiry values.
3. **Config format authority.** JSONC is primary; whether YAML is a supported authoring format (and how it maps to JSONC precedence) is undecided.
4. **Plugin permission model.** Whether plugins request capability grants or surface grants, and how review depth maps to v1.
5. **Hook surface freeze.** The exact v1 hook event set and whether experimental transform hooks ship or are deferred.
6. **Skill provenance signing.** Whether skills loaded from remote sources require a signature/digest gate in v1 or only local provenance.

## 20-ANALYTICS.md: Open questions

- Exact analytics projection retention/window and coverage metadata when canonical source facts themselves expire or are exported.
- Optional OTEL attribute set and stability guarantees.
- Whether "commits/PRs attributed" belongs here or in the orchestration/CI layer.

Managed run projections may add trigger_kind and environment_snapshot_digest to
RunAnalyticsRecord, derived from canonical Run/Attempt records. Strategy-efficiency
views may report attempts and observed token/cost use per independently verified task,
with unknown and included usage preserved. Analytics is downstream only: none of these
fields can feed a StopDecision, alter budgets, or establish completion (DEC-089).

## 22-SECURITY.md: Open questions

1. **Anchoring default vs. tamper-evidence intent.** **Resolved by `DEC-022`.** The
   default is **`local-sink`**: roots are always signed (signing is not configurable
   off) and anchored to a validated append-only sink outside the audit store root.
   `off-box` is required for any deployment that declares an off-box trust
   requirement; a configured-but-unreachable sink fails closed; `local-trust` remains
   available only as an explicit, acknowledged, labeled posture. `REQ-AUDIT-004` was
   reworded rather than lowered, and the claim boundary is now separately testable
   under `REQ-AUDIT-007`. The residual is unchanged and stays in the register:
   **fabrication and the unanchored tail are not detected by any local anchor**
   (`RR-02`, `RR-03`). What remains open is device-key rotation/escrow
   (`ARCH/security/AUDIT.md` Open question 1).
2. **ACP permission method name.** **Resolved by `DEC-023`.** The canonical, frozen
   wire token is `session/request_permission`; no alias is accepted and
   `request/permission` is not a transition form in either direction. `ARCH/integrations/PROTOCOLS.md` was
   corrected and `REQ-PROTO-002` now names the token, so `ACC-P1-03`/`ACC-P1-05` and
   the implementation agree. A second method identity is refused rather than
   transitional — that was the whole point of the question.
3. **`exec.run` rules and paths.** **Resolved by `DEC-025`.** Yes — `exec.run` rules
   match the **command token prefix only** and MUST NOT carry path-shaped resources; a
   path named by a shell argument travels as an `fs.*` resource, so exactly one path
   grammar and one command matcher exist and a path-shaped `exec.run` rule is a
   configuration error rejected at load. The reconciliation `REQ-SEC-003` could not
   state is now stated directly by `REQ-SEC-025` and `DEC-024`: the tool plane
   **extracts** and may only escalate, the guard **authorizes**, the sandbox
   **enforces reach**. Residual: a prefix rule is still not a semantic guarantee about
   what a wrapper will do (`RR-10`).
4. **macOS network-restricted profiles.** **Resolved by `DEC-026`, read through by
   `DEC-027`.** A
   `network: none` profile **is allowed** on the macOS tier; the tier declares
   `best_effort` with its residual, the level is surfaced wherever the profile is
   presented and recorded in that tier's acceptance record, and a caller requiring
   `enforced` is **refused** rather than silently downgraded. The backend is therefore
   not forced to declare itself unsupported — macOS stays a supported tier with an
   honest level (`RR-07`, `ARCH/security/SANDBOX.md` Open question 5, `ARCH/acceptance/ACCEPTANCE-MATRIX.md` Open question 8). What
   the read-through adds is that no statement anywhere in the set may present "network
   off" as what a tier *enforces*; it is the request the profile makes, and the
   declared level is the enforcement. `DEC-008`'s wording is unchanged — it is the
   request.
5. **Windows acceptance matrix.** Which specific filesystem, registry,
   child-process, and network restrictions are proven by which mechanism, and what
   record proves each? (`ARCH/security/SANDBOX.md` Open question 1; `TODO.md` Windows-containment task.)
6. **The trust principal for local state.** Declaring "the OS user is trusted, other
   unprivileged users are not" is currently implicit. Does it belong as an explicit
   clause, and does it need to be reflected in the recorded session configuration
   (`REQ-SESS-004`) so a portable bundle states its own trust assumptions?
7. **Cross-process session ownership.** Process-local ownership plus two surfaces is
   safe only with a cross-process append lock and a single-controlling-connection
   rule. Is a durable owner required before any multi-editor claim is made?
   (`ARCH/core/SESSION-AND-THREADS.md` Open question 2.)
8. **Machine-checkable "untrusted data" labeling.** Should the model request carry a
   typed wrapper that makes the untrusted/data status structurally explicit (rather
   than a rendered framing convention)? This would make `REQ-SEC-008` testable by
   construction; the mechanism is undecided.
9. **The catastrophic-gate catalogue.** Should the deny-by-default list that survives
   reduced-safety modes be a versioned, auditable artefact that is part of the
   security boundary and therefore a census class? (`ARCH/security/GUARD.md` Open question 4.)
10. **Skill/plugin pin format and signature.** The pin hash format is still open, and
    whether a signature is required in addition to a digest is undecided
    (`ARCH/core/CONFIG.md` Open question 6; `TODO.md` Open decisions). `X-02` shows the digest
    definition matters as much as the algorithm.
11. **Scan-class helpers.** A deny-list scan over changed files is proposed as a
    mitigation in `P-05`/`RR-12`. Its false-positive rate and whether it may ever
    *deny* (rather than warn) are undecided; a scanner that blocks legitimate work
    would push users toward disabling it, which is worse than the risk it mitigates.
12. **Threat-row ownership and review cadence.** Each row's `status` needs an owner and
    a review date; the mechanism (a tracker column, a review checklist in the release
    gate, or both) is not yet decided.

## 31-CONTROL-API-APP-SERVER.md: Alternatives and trade-offs

- **Direct TUI-to-core calls only:** simplest, but cannot keep a controller alive after
  the terminal exits or support a reconnecting client. Keep as an in-process transport
  for simple one-shot/attached operation, not as a separate API.
- **ACP as the internal API:** rejected because ACP is a negotiated external coding
  agent protocol and does not own HorizonCode's run/task/update methods or event
  cursors. ACP remains an adapter at the edge.
- **Always-on network daemon:** rejected for v1. Remote authentication, transport
  encryption, multi-user authority, and server administration are not product
  requirements yet.
- **Codex-shaped app-server:** reuse the shared typed-client and lifecycle boundary,
  not its internal schemas or unbounded local event queue. The targeted comparison is
  pinned to Codex commit
  [`368e5eae2f006a70a91dddfdc96e6b2d11498f81`](https://github.com/openai/codex/blob/368e5eae2f006a70a91dddfdc96e6b2d11498f81/codex-rs/app-server-client/README.md): it documents a shared in-process typed client for `codex-exec`/`codex-tui`, centralized startup/lifecycle and graceful shutdown, bounded command/runtime queues, and an unbounded local consumer event queue. HorizonCode adopts the shared boundary/lifecycle pattern, not the unbounded queue. Broader Codex source-trail entries may remain pinned to earlier snapshots and are not implied to have been refreshed by this targeted check.
