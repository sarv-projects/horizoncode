# HorizonCode test and benchmark plan

Status: **plan only**. No test, build, benchmark, or acceptance suite was executed
during the 2026-09-27 architecture audit. The source baseline is Git `53a2654`; the
Rust source tree is unchanged from `1c7a1c6`. See [`CURRENT_RUN.md`](../CURRENT_RUN.md)
for the exact handoff and [`ARCH/23-VERIFICATION.md`](../ARCH/23-VERIFICATION.md) for
evidence rules. A proposed test is not evidence that its behavior exists.
Current protocol references were rechecked against official ACP v1, its elicitation
RFD, and changelog on 2026-09-27. The RFD says elicitation was completed on
2026-07-22; changelog 1.7.0 (2026-08-20) stabilizes its schema, while 1.9.1
(2026-09-18) is the latest upstream release entry. Those semver values are not ACP
wire protocol versions; fixtures must pin an actual released schema revision rather
than follow mutable `main`.

## Goals and claim boundaries

The primary evaluation target is **verified completion of multi-hour software tasks**.
Cost, latency, memory, integration breadth, and UI quality are measured alongside
completion, but must not be optimized by silently lowering security, intent alignment,
or verification requirements. Do not claim that HorizonCode is better than another
agent until a reproducible, task-matched comparison has been completed and its failures
are published.

Keep these outcomes separate:

1. **Task success** — required acceptance scenarios pass on the exact integrated
   revision.
2. **Intent alignment** — implementation satisfies the original and confirmed user
   intent, including independent examples not copied from the implementation spec.
3. **Recovery correctness** — crashes, context loss, cancellation, and retries do not
   lose known progress, duplicate effects, or convert uncertainty into success.
4. **Safety** — effects obey the declared permission, filesystem, network, and
   deployment boundaries on the tested host.
5. **Efficiency** — tokens, money by currency and basis, elapsed time, CPU, RSS/PSS,
   disk, model wait, and human interventions are measured without conflating estimates
   with provider-reported facts.

Never treat model confidence, number of tool calls, number of child agents, lines
changed, a passing mock, or a provider's “completed” event as task success.

## Existing test inventory at the source baseline

This list is a file inventory, not a fresh run result. The referenced tests should be
re-read and run against the exact revision before relying on them.

| Area | Existing integration-test file(s) | Scope visible from source names |
|---|---|---|
| Analytics | `crates/horizoncode-analytics/tests/ledger.rs` | Ledger and rollups |
| Audit | `crates/horizoncode-audit/tests/chain.rs` | Chain behavior |
| CLI / ACP | `crates/horizoncode-cli/tests/e2e_acp.rs`, `e2e_acp_usage.rs` | ACP stdio and usage integration |
| CLI / audit and analytics | `crates/horizoncode-cli/tests/e2e_audit_analytics.rs` | CLI surfaces and persistence |
| CLI / headless | `crates/horizoncode-cli/tests/e2e_binary.rs`, `exit_codes.rs`, `state_root.rs` | Built-binary behavior, exit contract, state paths |
| CLI / tools | `crates/horizoncode-cli/tests/e2e_tools.rs` | Tool path through CLI |
| Guard | `crates/horizoncode-guard/tests/guard.rs` | Policy and approval rules |
| Provider | `crates/horizoncode-provider/tests/mock_transport.rs` | Mocked HTTP/SSE provider transport |
| Runner | `crates/horizoncode-runner/tests/e2e_loop.rs` | Turn loop, tool calls, limits, cancellation |
| Sandbox | `crates/horizoncode-sandbox/tests/sandbox.rs` | Host backend and path-policy behavior |
| Session | `crates/horizoncode-session/tests/log.rs` | Append/replay/resume/repair |
| Tools | `crates/horizoncode-tools/tests/mutations.rs`, `permission.rs`, `tools.rs` | Mutations, filtering, built-ins |

There is no test file inventory yet for the proposed run controller, durable goal/spec
state, task DAG, settings/command registry, UI, repository map, ACP client, MCP host,
agent directory, plugin/skill runtime, PR lifecycle, cost reservation, or multi-hour
recovery. Their target gates are specified below and in `ARCH/23`.

## Verification layers

Use the layer definitions and anti-claims in `ARCH/23`; do not promote lower-layer
evidence into a higher-layer claim.

| Layer | Run when | Required evidence |
|---|---|---|
| Unit | Every code change | Pure behavior, boundary arithmetic, typed errors, parsers, migrations, status transitions, no wall clock or live network |
| Contract | Every changed component/API | Schema and capability conformance; happy path, malformed input, unavailable dependency, denial, timeout, cancellation |
| Integration | Every governed effect class | Real temp directories/processes/worktrees/loopback fixtures; full guard → sandbox → effect → receipt path |
| Binary/UI E2E | Every user-visible change | Built executable or real terminal harness driven from outside the component; key input, output, exit status, setting persistence |
| Platform acceptance | Before platform/support claim | Exact OS/build/backend, observed filesystem/network boundary, residual and host details, raw evidence |
| Long-horizon acceptance | Before any multi-hour autonomy claim | `ACC-H1-01..10` on exact integrated revision, with restart, user-intent changes, artifact integrity, segmented-log growth, and storage-pressure recovery |
| Comparative benchmark | Before comparative quality claim | Pinned tasks/models/versions/budgets, paired runs, raw outcomes, uncertainty and complete failure log |

For Rust changes the planned local baseline is `cargo fmt --all --check`,
`cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace`.
Run crate-focused tests while iterating, then the complete workspace and applicable
platform/acceptance suites before changing a readiness claim. These commands were not
run in this documentation audit.

Use deterministic fixtures and injected clocks, IDs, random sources, homes, process
environments, model transports, and filesystem failures. Live model/provider tests are
opt-in experiments, never default test dependencies. All benchmark/test records bind
the build artifact, commit, spec digest, OS/runtime, configuration, model/parser and
test-data revision.

## Must-have adversarial suites

### Intent, goals, plans, and task state

- Preserve the original request verbatim; classify confirmed, assumed, excluded, and
  proposed behavior with provenance. Model-generated claims cannot become confirmed.
- Test ambiguity discovery, explicit answers, user correction, spec-version creation,
  and the exact affected-task/evidence invalidation graph.
- Evaluate a deliberately wrong but internally consistent specification against
  independent intent scenarios; result must be rejection or `INSUFFICIENT_EVIDENCE`,
  not success because spec-derived tests pass.
- `/goal set` persists the original request only: assert no model request, repository
  traversal/indexing, tool, or peer spawn. `/goal prepare` requires an explicit user
  action, finite separate budget, pinned base, and read-only repository capability;
  deny write, shell, child-agent, and external effects at the service boundary.
- Kill preparation before dispatch, after provider acceptance, and after response but
  before its receipt. Reconcile provider request/usage when supported; otherwise keep
  the goal inert, preserve a conservative reservation/unknown outcome, and require a
  new explicit preparation delivery. Same delivery plus same payload is idempotent;
  reused ID with changed input conflicts.
- Clarification creates a new proposal/spec/task/plan digest and invalidates stale
  review/approval receipts. A planner cannot label its own interpretation confirmed.
- Validate task DAG cycles, missing dependencies, stale spec digests, stale commits,
  worker `completed` without evidence, failed verification, and failed descendants.
- Clear the selected goal pointer for a paused run, restart/rebuild the projection, and
  verify the goal/run remain resumable by ID; reject clear for a running or wrong-scope
  run without changing durable goal/task state.
- Start a goal only against the displayed spec, task-graph, plan, base, route,
  permission, and budget digests; mutate each after review, inject unresolved ambiguity
  or reservation failure, redeliver the same receipt, and crash between accepted
  response, individual reservations, activation commit, projection update, outbox
  claim, worker launch, and launch receipt. No task dispatches before the durable
  `GoalActivated` event. Before it, recovery reconciles the same intent/reservation
  IDs or safely releases reservations; after it, recovery reuses the same outbox and
  attempt IDs. An unknown reservation/launch blocks new work until reconciled.
- Race two authenticated review surfaces for one goal: the newer challenge invalidates
  the older; out-of-order clicks, a stale tab, a reused delivery ID with changed
  payload, response from another control session, cross-connection replay, expiry,
  disconnect, changed policy/budget/base/route, or additional input cannot activate.
  Change policy or budget revisions in the race window between durable reservation
  and activation append; the revision CAS must reject and reconcile reservations. Let
  an accepted receipt expire before recovery; no activation may occur.
  Same-ID/same-payload retry returns the original challenge or result. Verify one
  pending challenge and one nonterminal intent per goal, exact rendered bundle digest
  equality, and that `ACCEPTED` alone is not shown as running.
- Race `/cancel` against `GoalActivated` repeatedly under a barrier. When cancellation
  commits first, assert activation is fenced, every created reservation is idempotently
  released, no outbox row/attempt is dispatched, and the intent reaches `CANCELLED`
  only after confirmed release. When activation commits first, assert the ordinary run
  cancel fence handles queued and in-flight work. Kill/restart during reservation
  release; `CANCEL_REQUESTED` remains visible and cannot become terminal while any
  reservation or launch is `UNKNOWN`. Replaying the same cancel delivery must not
  release twice or create a second cancellation event.
- Exercise typed `/cancel run <id>`, `/cancel task <id>`, and `/cancel attempt <id>`.
  Reject missing/foreign IDs, inconsistent ancestry, and mismatched operation scopes.
  A run cancel fences every new claim; task cancellation does not cascade to descendants
  or unrelated tasks and preserves a visible blocked-dependency reason; attempt cancel
  permits a new attempt only if retry policy, budget, and attempt limit allow it. Race
  each request with normal task completion, replay the same delivery, then reuse its ID
  with a changed target. Unknown child/process/effect outcomes must remain
  `RECONCILING`; a sent signal alone is not a cancellation receipt. Restart during
  cleanup and verify cancelled tasks remain cancelled while independent eligible work
  can continue. Confirm `/stop-now` exercises its separate hard-stop contract.
- Exercise start approval independently through TUI, CLI, and ACP. For ACP, test
  advertised form elicitation accept/decline/cancel, invalid schema, timeout,
  disconnect, reconnect/new-connection binding, and client without elicitation using
  the exact one-use typed receipt. Plain “yes”, extra text, stale/reused IDs, wrong
  session/principal, unauthenticated client, untrusted connector, and
  `session/request_permission` must never activate or dispatch. Assert ACP
  connection/session binding alone cannot mint an operator principal;
  `elicitation/create` is agent-to-client only; peer-originated elicitation when
  acting as an ACP client is ordinary untrusted input. The trusted connector must
  display every review digest and capture an explicit choice; the protocol itself
  does not attest a human saw the UI. Test worker invocation of the HorizonCode CLI,
  forged flags/env/config, direct local socket access, process-environment or
  descriptor/token leakage, canonical state/audit/budget/evidence path read and write
  attempts, symlink/junction/mount retargeting, and fake `todowrite` status updates.
  Denial leaves canonical state and the approval receipt set unchanged. A same-UID
  bare `full-access` profile refuses; an isolated worker identity/VM proves the
  private-state/control boundary on each claimed backend. Unit mocks do not prove
  process isolation. At the typed controller boundary, attempt to construct/deserialize
  a `MutationContext`, pass `UserActor { USER_OPERATOR }`, change a scope/run/epoch,
  reuse an expired or consumed nonce, replay a receipt on a different control session,
  or exploit a public constructor. Every forged request returns its specific typed
  denial (`WrongPrincipal`, `ScopeDenied`, `ExpiredCapability`, `ReplayConflict`) and
  leaves events, reservations, goal pointers, and receipts unchanged. Legitimate UI,
  CLI, and trusted-connector requests still bind to the authenticated origin.
  While approval is pending, non-receipt input invalidates the review before any
  model continuation. Muted notifications and custom color palettes cannot obscure or
  change the durable approval state.
- Verify controller pause fences before acknowledging pause; resume uses current
  state, durable counters, and a materially new bounded strategy after a no-progress
  stop. Repeated sessions/models do not reset retries.
- Test command intent against exact `/pause`, `/resume`, `/cancel`, `/stop-now`, and
  goal aliases; natural language, negation, quoted examples, another run's ID,
  ambiguous target, queued steering, and ordinary discussion of “pause”. Ambiguity
  must not dispatch another model turn before clarification.
- After compaction/model switch/restart, reconstruct goal, accepted spec, open work,
  budget, permission ceiling, user input receipts, and stop state from durable records;
  never rely on summary prose as source of truth.
- Empty successful model output, no tool calls, repeated reads, unchanged diffs,
  broken process waits, and “continuing” text are not progress. Waiting on timer, user,
  approval, child process, or provider quota consumes no model inference unless an
  explicit bounded poll action was scheduled.
- Foreground result and maintenance drain are separate. A CLI may report
  `maintenance_pending`, but may not silently print success and wait indefinitely.

### Durable state, tools, integration, and restart

- Crash before effect; after external effect but before receipt; between event append
  and SQLite projection; during task settlement; while applying patch; during checkout,
  merge, checkpoint, or PR creation. Restart reconciles before replay and never treats
  an unknown side effect as absent or successful.
- Segmented session/run event logs: cross every record/segment boundary; rotate at
  exact byte and record limits; verify dense sequence, event/segment digest links, and
  committed head; kill after append/before head, during seal/next-segment creation,
  during projection update, and during recovery. Inject missing/reordered/truncated
  committed segments and verify fail-closed behavior. Replay a large history while
  measuring RSS; memory must follow the configured batch bound rather than total log
  size. Race independent writers for the same session/run and event-byte reservation.
- Event-log quota and disk pressure: saturate artifact bytes without consuming log
  reserve, then saturate event bytes without consuming artifact quota; prove atomic
  parent/task reservations; fill storage near the hard boundary and verify dispatch is
  fenced before control/reconciliation/handoff reserve use. Disk-full during a tool
  result, cancel, terminal event, and effect reconciliation must retain a typed
  `UNKNOWN`/`RECONCILING` state and must never report `COMPLETED` without durable
  evidence. Check that UI/context compaction does not prune canonical records and that
  a resumed run requires approved capacity/policy revalidation.
  Verify the protected reserve is physically preallocated before activation and can
  still accept bounded control/handoff records under actual ENOSPC; a sparse reserve,
  free-space probe, or internal quota counter must fail the guarantee. Restart must
  revalidate reserve identity and allocation. Exercise each advertised filesystem
  backend; unsupported reservation behavior blocks that run profile.
- Read-only event-store non-mutation: snapshot all session/run files, lengths, hashes,
  metadata, and committed heads; exercise `read_only`, list, status, index verification,
  and export inspection with valid, corrupt, and unterminated final records. Every
  read path leaves the canonical bytes and recovery state unchanged. Explicit
  recovery must preserve/hash-pin the original tail, reconcile effect/operation IDs,
  write only an idempotent recovery record/new generation, and refuse when the
  external outcome is unknown. Test duplicate and changed-payload recovery IDs.
- Session-artifact fault matrix: concurrent writes racing the encoded-byte quota;
  oversize streaming without preallocation; temp-file symlink/replace races; duplicate
  digest with mismatching bytes; file flush, atomic rename, directory-flush and event
  append failures; disk-full and power-loss/restart at each boundary; orphan cleanup
  with a missing/unreadable directory entry; active lease and retention races; retained
  checkpoint/evidence/export/quarantined-tail references; corruption, truncation, wrong length, future
  schema, MIME mismatch, SVG/HTML active content, decoder timeout, decompression bombs,
  pixel/expansion ceiling, and media payload omitted from session export. Test every
  advertised filesystem durability backend; a backend that cannot meet the configured
  contract must refuse durable commit or report the explicit weaker mode.
- Copy-on-write artifact migration: interruption after each copied object, event,
  manifest write and generation switch; restart from source; power loss around atomic
  manifest publication; unsupported/newer schemas; source digest changed; duplicate
  IDs; corrupted target; rollback before switch; and GC while old/new generations or
  export jobs are retained. The original generation must remain byte-identical and
  authoritative until the complete target graph verifies.
- Repeat external requests using stable idempotency keys; inject duplicate delivery,
  mismatched content under a reused ID, timeout-after-commit, and provider response
  loss. Require an effect receipt or visible `UNKNOWN` result.
- For multi-file edits, fail on a later invalid hunk, symlink swap, changed base hash,
  permission loss, disk full, and process death. All files must be staged/preflighted
  or every partial effect must be durably enumerated.
- Tool response batches must be assembled, size/count/time bounded, permission-filtered,
  and validated before any member executes. Exercise rotated/non-adjacent calls,
  oversized nested arguments, stream overflow, cancellation, repeated rejected batches,
  and saved “always” approval. An over-limit batch dispatches none by default.
- Concurrency tests: competing task claims, expired lease with stale writer, two
  controller processes, concurrent budget reservations, overlapping worktree writes,
  deterministic merge order, late peer messages, duplicate event IDs, cursor gaps, and
  slow consumers. Control/approval/cancel lanes remain responsive while bulk work is
  saturated.
- Verify the merged integration revision, not only isolated worker worktrees. A
  conflict becomes evidence and a new bounded task; never silently select one result.

### Audit and filesystem/network boundaries

Run the audit matrix in `ARCH/23` `ACC-P1-04`: target-file byte/metadata snapshots
around actual CLI `verify`/`replay`/`census`; corrupt/missing head; torn line; corrupt or
missing segment; unreadable file; failed `read_dir`; iterator error; valid initialized
empty store; same- and cross-process writers; lock timeout/loss; sequence duplication;
head/segment/root mismatch; explicit repair preserving original bytes; access-stream
failure; authorization by actor/run/session/destination; redaction canaries; and
prepare/terminal reconciliation. Verify reads may not repair or rewrite evidence.

For every supported sandbox tier, execute `ACC-P1-01` on that actual OS/backend. Test
read/write roots, symlink/rename races, inherited file descriptors, subprocesses and
descendants, DNS/IPv4/IPv6, loopback, Unix sockets, helper services, VM sockets, proxies,
allowlist bypass, missing enforcement binary, and capability changes. Record observed
network reachability separately from syscall restrictions. Unsupported or unproven
requested guarantees are refusals. Linux namespace isolation, macOS Seatbelt, and
Windows paths need separate fixtures and evidence; one OS run cannot establish another.
Also prove `REQ-SEC-026` against real model-controlled child processes: the worker
cannot read or mutate canonical state or reach operator control, and approval comes
only from an authenticated trusted ingress. Same-user path checks alone are
insufficient.

Security suites include secret canaries through prompt, model errors, tool output,
audit, analytics, crash/panic reports, TUI notifications, exports, and peer receipts;
path/command injection; malformed config and partial writes; symlinked state/config;
extension archive bombs/traversal; untrusted web/MCP/skill instructions; stale policy
snapshots; privilege escalation; and reduced-approval/full-access composition.

### Providers, local runtimes, agents, and quotas

Treat `{provider, exact model, server version, tokenizer, prompt template, tool-call
parser, context limit, quantization}` as one tested route. A compatible HTTP endpoint
does not prove tool-call correctness or usage accounting.

For each supported hosted or local route test: authentication errors; 429 and
`Retry-After`; stream interruption; duplicate/partial tool-call chunks; invalid JSON;
thinking/reasoning fields; tool-choice modes; parallel calls; cancellation; context
overflow; output/token cap; cache read/write reporting; usage omission/duplication; late
usage; currency/pricing source; and provider status reset. Required missing capability
means route refusal or an explicit, accepted user override.

Output termination gets a dedicated decision table: completed, context-window rejection,
explicit requested output cap, validated server remaining-context cap, and unknown
finish reason. Inject generic `length` with a requested cap, a smaller remaining-context
cap, missing usage, mismatched route fingerprint, local-server version/template drift,
partial text, malformed partial tool JSON, provider-side tools enabled, streamed
side-effect receipts, user input/cancel during compaction, budget reservation loss,
compaction failure/truncation, retry route outage, and a second truncation. Assert that
only a validated remaining-context profile is eligible; partial tool arguments never
execute; incomplete assistant attempts survive restart but are excluded from completed
conversation context; both attempts and compaction are billed/recorded independently;
and retries never recur for the same `logical_step_id` after recovery depth is consumed.
Use Cline's local-model recovery only as a peer design precedent, not as evidence of
HorizonCode behavior or universal provider semantics.

Evaluate Ollama, LM Studio, vLLM, SGLang, MLX-LM, and llama.cpp with the same
model-weight/quantization where the backend supports it. Record the exact template and
parser. Measure tool call validity, schema adherence, cancellation latency, context
overflow, token/usage provenance, queueing and concurrent sessions. Do not call an
OpenAI-compatible endpoint “compatible” beyond the individual tested capabilities.

External-agent adapters (ACP and CLI/process) need per-capability tests for discovery,
path pinning/re-probe, install staging, launch, permissions, model selection, progress,
usage, cancellation, resume, child visibility, workspace ownership, output capture,
disconnect, and retries. Unsupported values stay `unknown`; peer completion does not
pass a task. Subagent quota tests distinguish HorizonCode-enforced launch budgets from
opaque internal provider quotas. Verify aggregate deduplication when parents and
children both report usage; preserve currency, basis, freshness, and provenance.

### UI, commands, settings, and accessibility

- Use an actual terminal matrix: truecolor, 256-color, ANSI-16, monochrome,
  `NO_COLOR`, `TERM=dumb`, slow/remote terminal transport, common shells and terminal
  multiplexers. Test keyboard collision discovery, custom remapping, composer focus,
  paste, resize, reconnect, and interrupted rendering.
- Check transcript/composer stability, virtualized large output, command palette,
  focus/docking, diff/editor modes, large/binary file handling, dirty buffers, external
  editor roundtrip and concurrent disk changes. Validate screen-reader labels, glyph
  alternatives, contrast, high contrast and reduced motion.
- Every semantic color is configurable through `/settings`; validate contrast and
  preserve distinct status/error/warning/approval meaning without color. Preview before
  apply; invalid or conflicting palettes are rejected with a useful explanation.
- Settings tests cover global/project/run precedence, schema version migration,
  effective value/source/lock display, invalid values, reload and restart boundaries,
  managed policy locks, stale agent capability snapshots, and settings that change only
  future runs versus active immutable policy.
- Command registry tests generate help/completion from schemas; unknown command,
  alias collision, malformed arguments, unavailable capability, stale ID, quoting,
  path spaces, Unicode and command-like user text never fall through into a model
  prompt or action. `@agent`, `@file`, `@task`, `@run`, and `@symbol` mentions resolve
  deterministically and never launch/grant authority by themselves.
- Agents panel tests include native and external agents, actual provider/model vs
  peer-managed/unknown values, nested visibility gaps, attempt tree, cost/quota sources,
  soft warnings, hard limits, stale quota, muted channels, pause/cancel responsiveness,
  failed connection, and recovered cursor snapshots.
- Test notification preferences independently: per-event/per-channel disable, sound
  off, terminal bell off, quiet hours, rate limiting, desktop permission denied, and
  required approval/stop persistence. Muting sound or desktop delivery never hides the
  in-client blocking state or durable event.
- “Auto-approve eligible asks” cannot affect explicit deny, protected paths,
  production/deploy/publish/push/merge, missing sandbox, external network, or expired
  run authority. Turning it off immediately fences future dispatch; in-flight effects
  are reconciled. Preference is not activation.

Current target commands, argument contracts, `@` namespaces, agent panel and settings
are in [`ARCH/27-COMMANDS-AGENTS-SETTINGS.md`](../ARCH/27-COMMANDS-AGENTS-SETTINGS.md).
They are designs; no interactive TUI exists at the source baseline. The attach tests
are **same-host/local-socket only**. A user-managed server may run headless; it does not
imply SSH UI access, remote-control protocol, multi-user isolation, or HorizonCode cloud
hosting.

## Multi-hour reliability and resource benchmarks

Build the internal acceptance workload before claiming long-horizon capability. Use
real multi-step repository tasks with hidden acceptance tests, dependency edges,
ambiguous requirements that require clarification, at least one intentional spec
revision, integrations/PR simulation, and optional parallel work. Run at short (10–30
minute), medium (1–3 hour), and long (4–8 hour) tiers; 25-hour experiments are a later
stress test, not an initial requirement. Kill the process/controller at random
durability boundaries and recover from cold start. Include offline waits and provider
quota exhaustion. No task is complete until final integrated-revision verification.

Benchmark paired baselines with identical repository commits, objectives/specs, model
weights and parameters, provider route, tool permissions, context limits, wall-clock,
token/currency ceiling, concurrency, temperature/seed where available, and verification
budget. Compare a single-agent loop, HorizonCode without delegation, HorizonCode with
bounded delegation, and selected peer agents (Codex, Claude Code, OpenCode, Cline,
Aider, Qwen Code, OpenHands, Goose). Use at least three pairs only as smoke evidence;
publish sample size, distributions, confidence intervals or uncertainty, raw per-task
outcomes, failures, and rerun policy. Do not compare public leaderboard scores as though
they were same-condition trials.

### Public benchmarks to include

- **Terminal-Bench 4.0** (released 2026-08-28) for terminal tasks and long-running
  workflows. It uses calibrated CPU/memory/time constraints, adjusts saturated tasks,
  and documents a flat eight-hour task timeout. Use its Harbor runner and pin the task
  suite/version; report container/runtime, timeout and agent harness. It complements
  rather than replaces coding-repository acceptance. [Official Terminal-Bench 4.0
  announcement](https://www.tbench.ai/news/terminal-bench-4-0).
- **SWE-Bench Pro V2** (leaderboard updated 2026-09-22) for realistic issue resolution
  across 642 tasks and 11 repositories. The revised process describes two-sided task
  gates, no network during the agent phase, and grading on a pristine image. Pin the
  dataset, Harbor task environment, images, verifier, network policy and grader; publish
  both agent and grader details. It cannot by itself measure long-horizon recovery,
  user intent alignment, or TUI workflow. [Official leaderboard](https://labs.scale.com/leaderboard/swe_bench_pro_public_v2),
  [dataset and methodology](https://github.com/scaleapi/SWE-bench_Pro-os/blob/main/README.md).
- Keep SWE-bench Verified and older Terminal-Bench versions as historical references
  only where comparison is useful; document contamination, saturation, task/patch
  validity, grader changes, network, retries, and model snapshot. Do not merge scores
  across incompatible versions.

Benchmark results need exact provider/API/model snapshot and price sheet. If usage is
not reported, label estimated or unknown; if a hosted agent hides its internal spend,
do not claim cost parity. Measure actual spend where observable and separately report
latency, total wall time, active inference time, waiting, and human time.

### Memory and throughput measurements

Measure cold-start, idle, active single run, compaction, indexing, and N concurrent
runs. Record process-tree RSS **and** PSS where available, peak/steady memory, allocator
growth, cache use, CPU time, disk growth, startup latency, event lag, tokens/sec, tool
queue delay, and cancellation latency. Include hosted models and local inference as
separate resource owners: model weights/server memory are not agent-harness memory.
Use fixed hardware/OS and state whether local embeddings/model weights are resident.

jcode's README reports Linux PSS figures for its own measured setups; these are
project-reported and must not be compared directly to HorizonCode RSS or used as a
target without reproducing its process tree, workload, cache, and embedding settings.
Keep process overhead and model-server memory as separate series. A memory optimization
must retain task completion, tool correctness, context recall, and recovery results.

## Metrics and release gates

Report at least:

- Verified completion and regression rate per task category.
- Intent-alignment failure and consequential-ambiguity escape rate.
- False completion, false stop, false continue, and pause-fence violation rates.
- Crash recovery success, recovery time, duplicated/unknown external effects, and stale
  worker write prevention.
- Correct tool-batch admission/refusal and no-progress loop rate.
- Cost per independently verified task, separated by source currency/basis; tokens,
  provider quota, elapsed time, waiting time, and human intervention.
- Context retrieval recall and context overflow; compaction loss against fixed probes.
- Delegation benefit after context replay, integration, and merge costs.
- RAM/CPU/disk and responsiveness per active run and per worker.
- UI command completion, keyboard reachability, accessibility, and notification delivery
  without masking state.

Release claims follow `ARCH/23` gates. Any unsupported platform, provider, agent
capability, usage amount, cost conversion, or quota is explicitly unknown or refused,
not silently inferred. Security-relevant failure, incomplete acceptance sub-check,
stale spec evidence, or hard-budget exhaustion blocks `accepted` status.

## Sources checked for the September 2026 plan

- [Cline v4.1.21 release](https://github.com/cline/cline/releases/tag/v4.1.21) — released 2026-09-24; documents local-model remaining-context output truncation recovery and explicitly limits automatic replay to text-only turns without tool activity. Treat this as route-specific peer evidence, not a provider guarantee.
- [DeepSeek-Reasonix releases](https://github.com/esengine/DeepSeek-Reasonix/releases) — checked 2026-09-27; Studio release notes report the image/event-log size and recovery problem that motivates `ACC-P1-09`. This is an upstream report, not a HorizonCode reproduction.
- [Codex Goals in the CLI](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex) — checked 2026-09-27; available in Codex CLI 0.128.0+; documents structured goal lifecycle commands, thread-scoped state, idle-boundary continuation, queued-input checks, no-tool-call suppression, and budget-limited stopping. These are peer workflow references, not a HorizonCode implementation or proof of multi-hour reliability.
- [Codex long-horizon task report](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex) — useful empirical workflow report; not a reliability guarantee.
- [Terminal-Bench 4.0](https://www.tbench.ai/news/terminal-bench-4-0).
- [SWE-Bench Pro V2 leaderboard](https://labs.scale.com/leaderboard/swe_bench_pro_public_v2) and [benchmark task/method README](https://github.com/scaleapi/SWE-bench_Pro-os/blob/main/README.md).
- [Agent Client Protocol](https://agentclientprotocol.com/) — protocol behavior must be capability/version pinned; ACP is not a scheduler or durable task database.
