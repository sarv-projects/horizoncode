# 23 — Verification

## Purpose

Define how a claim in `ARCH/` becomes **evidence**, at what layer that evidence is
allowed to be produced, and what a release may therefore assert. The rules that
matter most:

1. **A passing unit test proves that tested behavior, nothing more.** Containment is
   proven by an acceptance run on a real platform, not by a mocked syscall.
2. **A lower layer never raises a claim a higher layer owns.** A passing contract test
   never proves a wire protocol; a mock never proves a transport.
3. **No claim ships without evidence.** "Implemented but unverified" is a legitimate,
   honest state — it must be *labeled*, never implied complete.
4. **The gate must be runnable when the feature lands.** A gate that can only be
   satisfied retroactively is not a gate (`DEC-016`).
5. **Determinism is a test property, not a hope.** L1 unit and L2 contract tests
   inject time, identifiers, randomness, filesystem roots, environment, and transport;
   they do not depend on wall-clock time, external network, live models, or
   unrecorded host state. L3–L5 intentionally exercise real processes, loopback
   services, filesystems, and host confinement. Those runs use bounded fixtures,
   record the relevant environment, and are reported as platform-specific evidence,
   not portable deterministic tests.

This document owns the layered strategy, the determinism/flake policy, the P1
acceptance matrix, performance budgets, release gates, the definition of done, and
where evidence artifacts live. `ARCH/22-SECURITY.md` owns *what must be proven*;
this document owns *how it is proven and retained*.

## Scope

**In scope.** Verification of every `CMP-*` component and every `REQ-*` in
`ARCH/02-REQUIREMENTS.md`; the test layers and their exit criteria; the P1
acceptance matrix; determinism and flake policy; performance budgets and how they
are measured; release gates; the definition of done; and the production, naming, and
retention of evidence artifacts.

**Out of scope (handled elsewhere).** What the security boundary *is*
(`ARCH/22-SECURITY.md`); which mechanism implements a control (`ARCH/12`, `ARCH/13`,
`ARCH/14`); the compression/routing eval methodology itself (`ARCH/19`, `ARCH/09` §5,
`ARCH/11` §Lifecycle) — this document requires that those gates run and are recorded,
it does not re-define them; product/UX acceptance beyond the accessibility and layout
properties stated in `ARCH/06-UI.md`; and legal/licensing determination
(`DEC-011`, `DEC-012`).

## Strategy

### Layered strategy

Each layer answers a different question. Evidence from a layer is valid only for its
own question.

| Layer | Question | Real dependencies | May assert | Must **not** assert |
|---|---|---|---|---|
| **L1 — Unit** | Does this function compute the right thing, including at its boundaries? | None beyond pure crates; injected clock/id/rng/fs abstractions | Local determinism, error mapping, boundary arithmetic, canonicalization and glob semantics, hash-chain math | Anything about the OS, a process, a socket, or a protocol |
| **L2 — Contract** | Does each `CMP-*` honor its declared interface, schema, and failure contract? | Real types; fake ports for collaborators | Interface conformance, typed failures, fail-closed behavior, schema validity, "no second permission path" static gates | End-to-end effect execution; platform containment |
| **L3 — Integration** | Do real components compose correctly with real OS resources? | Real temp roots, real child processes under the local backend, loopback HTTP servers, real VCS worktrees, mock provider transport | The governed path per effect class; confinement behavior on the host kernel; audit chain mechanics; session replay and repair | Cross-platform claims; client/UI behavior |
| **L4 — E2E** | Does the built binary complete a real user-visible task from the outside? | The release build; a scripted ACP stdio client; headless invocation; a scripted TUI session | Protocol handshakes, permission round-trips, exit codes, one full coding task in a real workspace | Tier-specific containment depth; anything on a tier not exercised |
| **L5 — Acceptance** | Does the claim hold on a real platform, with a real anchor, against the declared trust model? | Real OS, real confinement backend, a real anchoring sink at the declared level, real user | Containment per tier, the tier's **declared** network guarantee level, anchoring at a declared level, Windows/macOS limits, performance baselines | Anything not recorded with build id, platform, and exact commit |

**Layer exit criteria (all must hold to leave a layer).**

- **L1 → L2:** every branch that can change a decision or a byte count has an
  assertion, including the "deny" and "refuse" branches; no assertion depends on
  iteration order of a hash map.
- **L2 → L3:** every inbound interface has at least one happy-path test, one typed
  failure test, and one **fail-closed** test (error, timeout, unavailable
  collaborator) — a component with no fail-closed test is not contract-complete.
- **L3 → L4:** the full governed path (authorize → confine → execute → record) is
  exercised at least once per declared security-relevant effect class, and at least
  once per *refusal* path in `ARCH/22` §Failure modes.
- **L4 → L5:** every user-visible capability is driven from outside the binary at
  least once, and every readiness claim has a named acceptance record path.
- **L5 (release):** the gates in §Release gates pass with retained records.

**Anti-claims (stated so they cannot be quietly relied on):**

- A unit test with a mocked filesystem cannot prove containment.
- A mock provider transport cannot prove a wire protocol, a retry policy against a
  real rate limiter, or prompt-cache behavior.
- A CI run on one platform cannot prove another platform.
- A browser/simulated surface cannot prove the real surface.
- A static catalog entry cannot prove a provider works.
- A unit-only result never satisfies a readiness claim for a risky capability class.
- A static architecture gate can prove that **no path-policy evaluation exists outside
  the guard** and that a path-shaped `exec.run` rule is rejected at load; it cannot
  prove that a particular path *would* be denied at runtime — that needs the L3
  governed-path run (`REQ-SEC-023`, `REQ-SEC-025`, `DEC-025`).
- A passing containment run proves the tier's **declared** network guarantee level,
  not a universal "no outbound network" claim for every platform; a stronger level is
  proven only by the mechanism named in the record (`DEC-026`, `DEC-027`,
  `REQ-GUARD-004`). "Network off" in a profile is the request, never the evidence.
- Audit verification proves modification of already-anchored history is detected. It
  does not prove content authenticity, does not detect fabrication by a principal
  with write access, and does not cover the unanchored tail (`REQ-AUDIT-007`).

### P1 acceptance matrix

The P1 phase (`TODO.md`, "Safe agent you can trust") has one exit: *a guarded,
sandboxed, audited coding task; policy changes behavior with no code change*. These
rows are the concrete, falsifiable evidence for that exit and its required
local session-search surface. Each row is a gate:
a skipped sub-check fails the row.

| ID | Item | What is proven (sub-checks) | Method | Pass criterion | Evidence artifact |
|---|---|---|---|---|---|
| `ACC-P1-01` | **Sandbox containment**, per supported tier | (a) a command cannot read a deny-globbed path; (b) cannot write outside the writable roots; (c) cannot rename a denied path out of the deny set and then read it; (d) with `network: none`, the tier's **declared network guarantee level** is the assertion: probe actual network reachability and the recorded residual using that backend's mechanism; syscall availability/policy is reported separately and is not substituted for reachability proof; (e) with an allowlist, only granted `host:port`+protocol succeed, and only when a forced broker is implemented; (f) applicable per-tier privilege/capability restrictions match the documented mechanism and are independently observed; (g) with the backend removed, the effect is **denied and audited**, not run unconfined; (h) namespace rearrangement, VM-socket bridging, inherited file descriptors, local IPC, helper-process and descendant paths are probed for escape; (i) reads are scoped to the granted roots on **every** supported tier, and a spawn naming an absolute path outside them is rejected or masked; (j) a caller requiring a network level the tier does not provide is **refused**, never downgraded; (k) explicit unconfined execution cannot be enabled from project/agent config, requires a one-use audited user grant and distinct worker identity/VM, exposes lost protections before confirmation, and remains unavailable if private controller/credential/audit state cannot be kept out of the worker view; (l) default/unmanaged, direct, deprecated, and fallback client-construction paths cannot satisfy a request that requires managed egress unless they pass through the same policy and enforcement checks | L3 + L5. Temp workspace with a deny-glob tree; probes cover external and loopback reachability, DNS/IPv6, inherited descriptors, local IPC, child processes, and broker bypass; record syscall policy separately from observed reachability; statically enumerate network client construction and separately exercise each supported factory path under a managed requirement | each refusal probe denies, each explicitly allowed probe succeeds, and observed network reachability, the declared level, mechanism, and recorded residual agree; a tier claiming a stronger level than it proves **fails** the row; no sub-check skipped; a skipped sub-check fails the run; the suite runs against each tier that advertises support | `acceptance/sandbox/<tier>/<build-id>.json` (including `network_guarantee_level`, `network_mechanism`, `network_residual`) + raw output + kernel/runtime versions + constructor/factory census |
| `ACC-P1-02` | **Guard precedence** | deny > ask > allow across multiple resources; the outer-scope deny ceiling is non-overridable; plan mode forces deny for every mutating class; unmatched ⇒ `deny` by default, may be `ask`, **never** `allow` in any layer; a malformed rule layer falls back to the previous valid layer and never widens; find-last-wins ordering; ticket scope/uses/expiry/epoch validation including the concurrent-use race; the persisted "always" rule equals the displayed pattern byte-for-byte; the built-in external-directory floor rule raises an outside-root `fs.*` resource to `ask`, is overridable toward `deny` and never toward a silent allow; a path-shaped `exec.run` rule is rejected at config load; a `bash` request carries the command-prefix resource **and** the extracted `fs.*` resources, and the guard returns exactly one decision over the combined set | L2 + L3. A committed **decision table** enumerating rule-order *classes* (deny-only, ask-only, allow-only, mixed, ceiling conflict, unmatched, malformed, multi-resource mixed effects, yolo-composition, plan-ceiling) — not an exhaustive permutation count — plus a **static L2 assertion** that a path-shaped `exec.run` resource is rejected at load and that **no path-policy evaluation is produced outside the guard** | the table is exhaustive over the declared classes; each row asserts exactly one effect; a test fails when the evaluator's semantics and the class list disagree; the yolo and plan rows are present (`DEC-073`); the floor rule never lowers a decision; the static gate fails on a second path evaluator | golden decision table + test report + the saved-rule store diff + the static-gate report |
| `ACC-P1-03` | **Approval round-trip through ACP permission request** | A guard `ask` emits exactly one baseline `session/request_permission` request with a schema-valid tool-call descriptor and all allowed decisions; opaque `optionId` values round-trip unchanged and `kind` is one of the negotiated schema's values; exact reply maps to the guard decision; method-not-found, malformed/unknown option, disconnect, cancellation, and timeout each produce distinct typed outcomes and fail closed; a user rejection is not model-facing feedback unless explicitly supplied; a durable allow is offered only when the exact remembered rule can be represented and is shown before confirmation; concurrent requests cannot block cancel/control | L3 + L4. Scripted ACP stdio client over an in-process pipe; pinned released schema fixture; record sent and received frames | Exactly one effect receipt per request; exact request/reply correlation; audit evidence and terminal state match the actual selection; unknown/malformed decisions never allow; cancellation is distinct from rejection; allow-always cannot widen beyond the displayed effect | Paired NDJSON transcripts + pinned schema version + audit segment and effect reconciliation |
| `ACC-P1-04` | **Audit verify, read authorization, concurrency, and completeness** | Untampered chains verify; negative-control copies exercise appended, removed, reordered, truncated, and modified entries; malformed/missing head, corrupt segment, unreadable file, `read_dir` failure, and iterator failure return typed errors rather than clean/empty; actual CLI `verify`/`replay`/`census` leave target bytes and metadata unchanged, including when access evidence is enabled; cross-process writers produce unique contiguous `audit_seq` values and valid segment roots; a class census fails for an uncovered class; per-effect reconciliation detects missing/duplicate prepare/terminal receipts and cross-store mismatches; a redaction canary is absent from entries, roots, access receipts, verify/replay output, and exports; access authorization is actor/scope/destination-bound and persisted to the independent access stream before disclosure; an access-stream write failure denies disclosure; the record states the real anchor level and precise `REQ-AUDIT-007` boundary. | L2 + L3 + L5 for the declared anchor level. Spawn at least two real writer processes behind a barrier; inject filesystem read/enumeration errors; hash the target store before and after each CLI read command; separately test access-ledger outage. | Every corruption/read failure is non-zero/typed and never appears as an empty clean audit; all target bytes/metadata are unchanged by read operations; the only accepted empty result has a valid initialized-empty marker; parallel writers have no duplicate or skipped sequence; repair requires explicit authorization, preserves corrupt bytes, and emits a linked new artifact; every granted read has a durable access receipt before output. | tamper/read-error matrix; before/after digests; multi-process sequence/root report; access-ledger receipt and outage transcript; census/reconciliation artifacts; anchor receipt and rendered claim-boundary capture |
| `ACC-P1-05` | **ACP stdio handshake with capability advertisement** | `initialize` negotiates a pinned wire version and advertises only implemented, tested methods/capabilities; baseline `session/new`/`session/prompt`/`session/cancel` follow v1; optional `load`, `resume`, `list`, `delete`, `close`, `set_mode`, and `set_config_option` are gated by their exact v1 capabilities; `session/fork` is not advertised unless the explicitly enabled unstable extension supports it; UI detach and task graph operations do not appear as ACP methods; malformed frames and unsupported methods fail without session mutation; two clients cannot silently own one control lease | L4. In-process stdio plus schema conformance against the pinned ACP v1.9.1 release schema | Generated advertised-capability list equals implemented-and-tested support; every unavailable optional call fails typed; unstable fork is absent by default; no panic or silent no-op | handshake transcript + schema-version pin + generated capability-coverage diff |
| `ACC-P1-06` | **Session replay/resume determinism** | replaying the same committed segments twice yields **byte-identical** projections; read-only replay/list/status leave source bytes and metadata unchanged, including with an incomplete active tail; explicit recovery preserves/hash-pins that tail and reconciles effects before adding deterministic closers in a new generation; a crash mid-turn loses no acknowledged step; `fork` at a boundary produces a child whose inherited prefix is exactly the parent's events through the cut; the index rebuilds from the committed head to identical rows; a newer format is refused typed with **no partial decode**; a moved workspace root is refused with re-point guidance and never guessed; per-key ownership admits one drain and a second resume joins | L3 + L4. Real process kill/restart (not a simulated crash) + committed golden transcripts; before/after byte and metadata hashes for read paths | golden projection/recovery comparison is byte-identical; read-only source hashes/metadata do not change; the kill/restart matrix runs ≥20 times with zero divergence; the newer-format case produces zero decoded events | golden transcript hashes + before/after read-path hashes + restart matrix (per scenario, with divergence count) |
| `ACC-P1-07` | **Compaction continuity** | automatic compaction defaults on and triggers at the configured utilization fraction of the active route's resolved model window (default 0.5), not a fixed token count; the output/buffer/uncertainty reserve is independently enforced as a hard fit guard; `auto=false` suppresses threshold and all automatic recovery while preserving manual compaction; a hard-fit miss then returns `CONTEXT_TOO_LARGE` without dispatch; after compaction the context contains every fact in the pre-registered probe set; code/tool observations use verbatim selection/grouping or exact recovery references, never abstraction; a boundary never splits a tool call/result pair; a provider rejection and proven remaining-context truncation share one persisted recovery budget per logical step and each recovery is admitted only under its typed cause, auto=true, unchanged route/revisions, no possible side effect, and reserved budget; second failure is terminal; failed summary never half-lands; checkpoints record shadowed range/count without rewriting canonical history; stable prefix is byte-stable until a real change | L3 (mock provider) + offline retrieval probe; route fixtures with different context windows and typed termination causes | configured fractional threshold is honored across route windows; manual/automatic controls remain distinct; `auto=false` causes zero automatic compactions/retries on threshold, hard-fit, provider-rejection, and output-truncation paths; hard-fit refusal dispatches nothing; probe recall = 100% on the pre-registered set; zero unbalanced spans; at most one recovery per logical step; prefix-stability holds | probe-set results keyed by strategy version; paired A/B report when a strategy changes (`DEC-016`) |
| `ACC-P1-08` | **Headless exit codes** | every terminal state maps to exactly one documented code; `declined`/guarded-deny and `completed` differ; an interrupt emits its terminal event **before** exit; `--format json`/`ndjson` emits one typed event per line and a bounded buffer surfaces a typed error rather than dropping events; a configuration error is distinct from an internal error; a resume of a nonexistent session is a configuration error; a signal mid-turn yields `interrupted` plus the documented code; the numeric mapping in `--help` matches the implementation | L4 on the release build | the code table is asserted per terminal state; a test fails if the table and `--help` disagree; the NDJSON stream is schema-validated line by line | exit-code matrix artifact + the `--help` contract snapshot |
| `ACC-P1-09` | **Session artifact integrity, limits, migration, and recovery** | ingest streams under an atomic per-session quota reservation; rejects encoded-size overflow before unbounded allocation; verifies exact bytes/digest/length and MIME sniffing; artifact publication precedes the referring event commit; crash/disk-full at temp write, flush, rename, event append, and projection update leaves either a valid referenced blob or a typed orphan/recovery state; tampered, missing, symlinked, wrong-length, unsupported-version and decoder-bomb objects never become empty or accepted evidence; decoded dimensions/expansion/time limits hold before UI/model use; image use requires vision capability, egress authorization and context budget; fork/export/import preserve exact refs/digests; copy-on-write migration interruption leaves the source generation authoritative; GC cannot delete artifacts referenced by retained sessions/checkpoints/evidence/exports/quarantined tails/leases and refuses incomplete enumeration | L2 + L3 + L4, with platform L5 for declared persistence guarantees. Fault-inject filesystem operations and use real process kill/restart; test every supported filesystem durability backend | no partial session publication; every committed ref resolves to matching immutable bytes; every failure remains typed and recoverable; source log/generation bytes remain unchanged during migration; a repeated recovery yields the same manifest/projection; no unmarked owner is collected | `acceptance/session-artifacts/<platform>/<build-id>.json` + raw crash matrix, manifest/log hashes, migration report, GC mark set and filesystem/backend declaration |
| `ACC-P1-10` | **Provider output truncation classification and bounded recovery** | normal completion, pre-content context-window rejection, explicit output cap, proven remaining-context cap, and unknown truncation normalize distinctly; generic/unknown finish reasons and explicit output caps do not compact-retry; only a version-pinned, conformance-validated route capability establishes remaining-context semantics; one shared recovery is admitted per logical step only if no tool was dispatched and provider-side tools/effects could not execute, the pinned route and user-input/control/task/workspace/spec/policy revisions remain unchanged, `compaction.auto=true`, and budget is reserved; partial bytes/usage and attempt identity persist as incomplete, partial text is not replayed as completed assistant input, and tool proposals are buffered until a complete validated response; partial provider usage is retained/accounted once; absent token/cache/reasoning fields remain `UNKNOWN`, never zero; second truncation is terminal and user cancellation wins every race | L2 + L3 deterministic provider fixtures, then per-route conformance for routes claiming remaining-context semantics | zero retries with `auto=false` and for explicit/unknown caps; no more than one recovery per logical step across overflow and truncation; exactly one recovery for an eligible isolated cause; zero tool side effects; no retry after revision/cancel/budget change; partial artifact/usage retained and accounted once; no false completion | `acceptance/provider-truncation/<route-id>/<build-id>.json` + pinned server/model/template profile, wire transcript, retry admission decision, session event refs and usage ledger |
| `ACC-P1-11` | **Bounded segmented canonical logs and replay** | Session and run event records/segments/aggregate bytes are bounded; quota races reserve event bytes atomically and separately from artifact bytes; each event/segment digest chain and committed head validate; rotation preserves dense sequence and exact bytes; projections rebuild in bounded batches without whole-log allocation; crash/disk-full at append, head update, seal, segment creation, projection update, or recovery yields either the prior committed head or a typed recoverable state; no acknowledged event is lost; no in-run history is pruned; physical emergency control capacity is proven on each supported backend and survives restart | L2 + L3 + L4, plus L5 for each declared filesystem durability/reservation backend. Large synthetic sessions/runs, real process kills, injected disk/rename/sync failures, and actual ENOSPC | fixed-memory replay batch bound holds as total history grows; all acknowledged sequence/digest pairs survive restart; only post-head bytes remain uncommitted; quota exhaustion fences dispatch before reserve use and can persist cancellation/reconciliation/handoff; reserve cannot be read/written by workers; event and blob ledgers do not overspend one another; backend unable to prove reserve refuses activation | `acceptance/event-log/<platform>/<build-id>.json` + segment/head manifests, RSS/latency traces, quota and physical-allocation receipts, raw fault matrix, before/after event-chain digests |
| `ACC-P1-12` | **Read-only event access is non-mutating and never hides store failures; recovery is explicit** | `read_only`, list, status, index verification, and export inspection perform no canonical writes, truncation, repair-event append, head advance, or metadata change; malformed/incomplete tail remains byte-identical; directory/iterator/index/session read failures appear as typed issues or unavailable rows, never as an empty list or missing session; enumeration and per-entry errors follow the typed semantics defined above; any future SQLite inspection path uses a driver-level read-only handle and rejects attempted writes; explicit recovery preserves source bytes, reconciles effects/operation IDs, is idempotent for the same recovery ID, refuses changed-payload replay, and returns `INSUFFICIENT_EVIDENCE` when an effect cannot be resolved | L2 + L3 + L4. Snapshot file bytes, lengths, timestamps and committed heads before/after every read route; inject directory, iterator, index, and per-session read errors; attempt DDL/DML through a read-only DB connection | all read-path hashes/metadata remain equal; every injected scan/read failure is visible; DB writes fail at the connection/mode layer; recovery never drops source bytes, never duplicates effects, and never marks unknown outcomes complete; repeating recovery produces the same result | `acceptance/session-read-recovery/<build-id>.json` + before/after store snapshots, enumeration issue records, recovery/effect joins and refusal transcripts |
| `ACC-P1-13A` | **Commit durability primitive** | `CommitSink` and `DurabilityProfile` order event-file sync, committed-head sync, and required parent-directory sync before reporting durable success; unsupported sync backend and disabled per-append sync are refused; this gate covers only the primitive's declared operations, not segment rotation, session migration, or physical reserve | L2 + L3 deterministic ordering/fault fixtures on the implementation's supported backend; platform-specific claims remain under `ACC-P1-13` | sync order is exact; any failed/unavailable sync returns no durable success; weaker interactive profile remains labeled; no claim is made for ENOSPC control reserve or segmented store | `acceptance/commit-durability-primitive/<platform>/<build-id>.json` + operation trace, injected failure cases, backend/profile identity, exact revision |
| `ACC-P1-13` | **Integrated crash-durable event and namespace commit** | New-session creation, segment rotation, seal/head replacement and event acknowledgement synchronize file content plus every required directory/namespace update for the declared platform backend; a failed sync never returns a durable success; run-durable mode cannot disable it; the physical control reserve survives restart and is usable under ENOSPC. This gate builds on primitive evidence from `ACC-P1-13A`; it is not a prerequisite for that primitive gate. | L3 process-kill/fault injection + L5 on each declared OS/filesystem/backend; real ENOSPC and supported power-loss test method | no acknowledged event/head/created session is lost in the declared failure model; unavailable sync/reservation behavior refuses the profile; evidence records filesystem, mount/volume, runtime, hardware/cache assumption and exact operation sequence | `acceptance/storage-durability/<platform>/<build-id>.json` + raw sync/rename traces, head digests, reserve receipts and fault/restart results |
| `ACC-P1-14` | **Local full-text session and title search integrity** | Message/title FTS projections exactly match a bounded reference scan of verified committed displayed revisions using a pinned extractor version; query parsing provides whole-token and quoted-token-phrase semantics without exposing raw FTS operators; title context/alias rows follow the no-duplicate rule and verify historical title digests; stable total order includes hit kind and source sequence with keyset cursors, no skips/duplicates on tied rank/time; message navigation resolves the exact immutable message ID; hidden reasoning/transient/uncommitted/non-text content is excluded; tool output follows opt-in and is hidden immediately on opt-out before purge; authorization, filters, rename, deletion/expiry, privacy purge, and rebuild semantics are correct; `COMPLETE` proves stable full authorized Thread enumeration and each captured head indexed, including global registry pagination; missing FTS5, corrupt indexes/sessions, incomplete enumeration, stale generations, and deadlines return typed non-complete coverage; read/search never mutates canonical logs | L2 + L3. In-process SQLite with FTS5 and fixed Unicode/tokenization/extractor fixtures, reference-scan oracle, crash injection across event/projection/index-head commits, authorization/catalog-generation fixtures, and 10k/100k synthetic corpora | exact result/digest parity; zero cross-scope or excluded-content leaks; no stale/unverified snippet or wrong-message jump; rebuild is byte/digest deterministic; equal sort keys paginate without duplicate/skip; opt-out hides existing rows immediately; incomplete/corrupt/timeout/loading scope never appears as a complete miss; measured latency/RSS report states environment and no unmeasured target is called a pass | `acceptance/session-search/<build-id>.json` + SQLite schema/extractor/index-generation digests, reference oracle report, query fixtures, crash matrix, coverage/error captures, and benchmark report |
| `ACC-P1-15` | **Stable Thread identity and crash-safe session-format migration** | Every local conversation resolves to exactly one stable internal `ThreadId`; worker retries/restarts create distinct `WorkerExecution` records without changing that identity; external ACP/provider session IDs remain bindings; Task DAG and Thread tree are independently represented; v1 session IDs/message IDs/cursors/event bytes/unknown fields survive a versioned migration; migration writes and verifies a separate target generation before switching the active pointer; crash at each migration boundary permits idempotent resume or rollback without source mutation; imported/exported history and search references resolve to the same messages; thread or execution terminal status cannot pass a Task | L2 + L3 + L4: schema/property tests, old/new fixture bundles, migration crash injection at copy/verify/switch/receipt/cleanup boundaries, restart and duplicate-run tests, task-verifier integration | one identity per conversation and no lost/duplicated/reordered committed event; legacy generation remains byte-identical; repeated migration is idempotent; source/target digests and receipts agree; adapter Session IDs cannot collide with local Thread identity; completion requires independently bound Task evidence | `acceptance/thread-migration/<build-id>.json` + source/target manifests and digests, migration receipt, crash matrix, graph/cursor parity, and verifier refusal evidence |
| `ACC-P1-16` | **Durable, typed agent question and answer flow** | Native questions persist before UI acknowledgement and bind to exact thread/turn/tool call plus Run/Task/Attempt when present; stable option IDs, single/multi/text cardinality, required/other handling and size/count bounds validate; unknown option, stale request, duplicate delivery with changed payload, missing auth, expired/cancelled request, and unsupported external adapter return typed outcomes; answer receipt commits before delivery and process/client crash between these points reconciles without duplicate or lost answer; only the requesting safe-boundary call waits; child requester/parent route is exact; headless emits resumable `NEEDS_INPUT`; a mixed question+tool batch dispatches no siblings, reports `not_run_question_boundary` after the answer, and replans; malformed/multiple question calls reject the whole unstarted batch; external elicitation fences new calls and reconciles in-flight effects; permission/goal approval/evidence cannot be minted by an answer | L2 + L3 + L4: schema/property tests, real TUI scripted sessions, headless JSON/exit contract, control API idempotency tests, process-kill matrix, native/ACP/opaque adapter fixtures; fake provider emits question+write/bash/network calls, malformed question, duplicate questions, and external elicitation racing dispatch | exact option/cardinality enforcement; answer survives reconnect and reaches only its originating call once; no first-option/default answer; no sibling effect crosses the question boundary; suppressed sibling outcomes are typed; unsupported capability stays unknown; cancellation is distinct; no permission, goal, or Task status changes; pending-question resource ceiling and control-lane responsiveness hold | `acceptance/agent-questions/<build-id>.json` + event/receipt digests, schema fixtures, adapter capability reports, mixed-batch and race traces, crash/replay matrix, TUI interaction/a11y captures, and headless transcript |
| `ACC-P1-17` | **Asynchronous evaluation freshness fencing** | Planning/review/goal/evaluator result records the exact spec, graph, workspace/base, policy, input, and source event revisions it read; before any dependent commit/dispatch, controller reloads authoritative state and compares; a newer user message, cancellation, spec/policy/workspace change, or terminal task invalidates stale result; stale outcomes cannot complete, reopen, overwrite or dispatch; concurrent evaluations settle deterministically and retries consume fresh bounded budget | L2 + L3 + L4: controller state-machine/property tests, deterministic race barriers, process restart between evaluation and commit, provider/tool calls stubbed with explicit result ordering | stale result is diagnostic-only; no stale goal completion or task PASS; new evaluation references the new revision and has budget; cancellation and changed intent win; no duplicate dispatch | `acceptance/evaluator-freshness/<build-id>.json` with event sequence, revisions/digests, race schedules, controller decision, and budget receipts |
| `ACC-P1-18` | **Pinned route fallback, retry safety, and conservative capability/cache projection** | A managed attempt persists its primary route and ordered fallback chain before dispatch; catalog refresh cannot change either; every retry obeys `REQ-PROV-015`: finite attempts/deadline, bounded multiplier and absolute delay, clamped `Retry-After`, preserved terminal error, and body replay only with proven non-acceptance or documented idempotency plus the same stable key; transient pre-content cross-provider fallback is allowed only to a compatible, authorized, budget-reserved pinned route; no fallback occurs after content/tool exposure, on auth/quota/policy/protocol/capability errors, or cancellation; each dispatch has its own route/cost/usage evidence; cache, tool, vision, reasoning, streaming, and structured-output capability is reported only for the exact adapter/model route whose metadata and request/usage semantics passed conformance; missing/malformed fields stay `unknown`, never default to positive support; local OpenAI-compatible endpoints default cache usage to unknown | L2 + L3: deterministic fake provider transports with ordered failures/deltas, duplicate-body/idempotency fixtures, bounded `Retry-After`/deadline and retry-exhaustion fixtures, strict catalog schema and omitted-field fixtures, immutable catalog snapshots, policy and atomic-budget fixtures, provider adapter request/usage fixtures | no body replay after uncertain acceptance without a stable key, no unbounded delay/retry, actual terminal error is preserved, no hidden endpoint/recipient change, no duplicate visible output or tool call, no unreserved spend, no cache-hit/savings claim or unsupported feature dispatch without capability evidence, all retry/fallback outcomes and route digests are auditable | `acceptance/provider-routing/<build-id>.json` with pinned chain, per-dispatch route snapshots, transport transcript, exposed-content boundary, budget receipts, schema/capability projection, retry attempt/error records, and cache capability/usage fixtures |
| `ACC-P1-19` | **Model-facing retrieval from compacted Thread history** | When enabled, `history_search` and `history_read` retrieve only committed, user-visible records from the controller-selected current Thread; stable IDs/sequences and exact authorization are revalidated on read; results are bounded and report `COMPLETE`, `PARTIAL`, `EXPIRED`, or `UNAVAILABLE`; hidden reasoning, ephemeral/uncommitted records and disabled tool output stay excluded; retrieved history remains untrusted context and cannot satisfy task verification | L2 + L3: tool contract/property tests against canonical event fixtures and FTS index, compaction/restart/rebuild/crash fixtures, controller identity and authorization tests | a match can be traced to its exact committed message; no cross-Thread access or path/ID substitution; partial history is never presented as complete; disabling tool output removes it from results; history text cannot create evidence or permission; response byte/token ceiling holds | `acceptance/history-retrieval/<build-id>.json` with query/ref receipts, thread and event digests, coverage state, authorization decisions, prompt-injection fixture, and budget accounting |
| `ACC-P1-20` | **Route-specific system-prompt update semantics** | Full effective-prompt replacement is the default; an in-history update is accepted only for a pinned route/model capability whose documented semantics say later system messages replace the effective prompt and whose adapter reconstructs the exact expected prompt; unknown/unsupported behavior replaces; changes/removals, compaction, resume, route refresh, and tool-schema changes cannot leave stale or duplicated prompt state | L2 + L3 deterministic adapter request-reconstruction fixtures; optional route-specific live conformance is separate and user-authorized | captured request equals the declared effective prompt at every step; no old instructions silently persist or disappear; unknown routes never use append; route/context epoch digest changes when semantics change; cache-hit claims remain independent | `acceptance/system-prompt-update/<route-id>/<build-id>.json` with pinned capability source, request transcript, effective-prompt oracle, context epoch and route digests |
| `ACC-P1-21` | **Effect approval is principal-, connection-, content-, revision-, and time-bound** | Create pending approvals through two authenticated control connections; only the exact originating principal/control session/connection can answer; disconnect durably invalidates unanswered challenges before teardown; expiry and cancellation deny; duplicate delivery is idempotent; changed digest conflicts; mutate the displayed payload, file bytes, workspace head, policy, task/spec revision, or cancel generation after display and before execution; race cancellation and each extension callback with approval return; executor re-reads current revisions and resource digest at the effect boundary; stale approvals produce `STALE_APPROVAL` and no side effect or automatic re-ask | L2 + L3 with two real authenticated local clients, deterministic race barriers, and a controlled filesystem effect fixture; no live provider/service | foreign connection never resolves the challenge; disconnected/expired/cancelled/stale challenge never authorizes; callback/cancel race cannot mint a ticket; effect bytes match shown digest or do not execute; exactly one terminal challenge state and auditable refusal receipt | `acceptance/approval-freshness/<build-id>.json` with challenge/display/effect digests, connection identities, revision vectors, cancellation generations, race schedule, guard decision, and zero-side-effect assertions |

**`ACC-P1-04` amendment (`DEC-031`).** In addition to its class census, inject two
effects of the **same** class and omit one terminal receipt; verification must fail
on that exact `effect_id`. Also inject a duplicate terminal receipt and an effect
prepared before a process kill; the former fails, and the latter remains `unknown`
until reconciliation proves its outcome. A class with one entry is insufficient.

**Forward-declared (later phases, not P1 gates).** `P2`: repo-map/LSP/indexing
determinism; checkpoint/rewind round-trip; deterministic merge arbitration given
identical inputs; routing eval-gate evidence (`ARCH/11` §5). `P3`: worktree lease and
merge under concurrency; task-graph durability across compaction/restart; peer-pool
supervision; WASM skill/plugin confinement. Each is declared here so the evidence path
is agreed before the feature exists, not after.

**Route-specific provider acceptance record.** `ACC-PROV-OC-GO` — live acceptance of
the native OpenCode Go connector (`REQ-PROV-009`, `REQ-PROV-010`, `DEC-060`):
fixed-origin model-directory fetch, user-owned Go API key resolved through
`CMP-secrets`, HorizonCode request identity, reviewed model-to-path mapping across the
allowlisted `/responses`, `/chat/completions`, and `/messages` routes, streaming/
cancel/usage/error normalization, and explicit refusal of unmapped model IDs. Evidence
path `acceptance/provider-opencode-go/<build-id>.json`; owner `TODO.md` `AX-364`,
gated by `AX-360..363`. An unsigned or mock transport cannot satisfy it, and
HorizonCode must not be described as an OpenCode-validated client.

### Determinism and flake policy

**Injectable substrate (a hard prerequisite for any test).** No test may reach the
real world for any of these:

| Injected | Rule |
|---|---|
| Clock | A `Clock` trait (monotonic + wall) with a test implementation. TTLs, deadlines, retry backoff, and budget windows read it. **No `sleep`-based synchronization anywhere.** |
| Identifiers | A uuid source injected per test; golden transcripts must not depend on minted ids unless the id source is frozen. |
| Randomness | A seeded RNG; jitter is production-random but seed-injectable in tests. |
| Home / state dir | A per-test temp root; no test reads the developer's real config, state, or `HOME`. |
| Environment | A per-test env map; no test mutates the process environment globally. |
| Transport | Provider and HTTP are exercised through mock/in-process transports. |
| Process/sandbox | `SandboxProvider::probe` is injectable so backend-absence can be tested without uninstalling anything. |

**Transport rules.**

- **Mock provider transports only.** A deterministic scripted transport returns a
  recorded request/response sequence; it can inject a typed overflow, a rate-limit
  hint, a malformed frame, and a pre-content interruption.
- **Loopback servers only.** Any test that needs a socket binds `127.0.0.1`/`::1` on
  an ephemeral port. A helper wraps the HTTP client so an attempted connection to a
  non-loopback destination **fails the test loudly** rather than reaching the internet.
- **No live model, ever.** No test may require an API key, a network route, or a real
  provider account. Provider-specific behavior is asserted through adapter conformance
  fixtures recorded from the wire format, marked with the date they were captured.

**Determinism rules.**

- No wall-clock timestamps in assertions. Where a timestamp is part of the record,
  assert ordering and monotonicity, or use the frozen clock.
- No dependence on hash-map iteration order, filesystem enumeration order, thread
  scheduling, or `PATH` ordering. Any place that needs a deterministic order declares a
  total order explicitly.
- No dependence on locale, timezone, or `TZ`.
- No dependence on the host's filesystem, temp-directory location, username, or
  network conditions.
- Golden files are committed. A golden diff must be **reviewed**, never auto-accepted
  by an update flag in the same change that caused it.
- Randomized/fuzz testing uses a **recorded seed**; the failing seed is committed as a
  regression corpus entry.

**Repeat and quarantine policy.**

- The full suite runs **≥5 consecutive times** on the merge gate with zero failures.
- The determinism-sensitive suites (`ACC-P1-01`, `ACC-P1-04`, `ACC-P1-06`,
  `ACC-P1-07`) and any test using real processes run **≥20 repetitions**.
- **No silent quarantine.** A quarantined test requires an owner, a reason, a linked
  issue, and an expiry date; a quarantined **security-relevant** test is an immediate
  release blocker. Quarantine count is a reported metric, not a hidden flag.
- A flake re-opens the owning requirement's evidence: a requirement that flaked has
  not demonstrated determinism, regardless of its pass rate.
- Every test has an explicit timeout. A hang is a failure that dumps the last events,
  not a stuck job.

**Adversarial-input coverage.** Parsers for untrusted formats — protocol frames,
config, tool input/output, patch text, package archives, catalog records — have fuzz
targets. A crash, an unbounded allocation, or a panic found by fuzzing is a release
blocker, and the minimized input is committed to the corpus.

### Performance budgets

**Measurement discipline (a budget without a recorded baseline is *unmeasured*, not
passing).**

- A repeatable benchmark procedure with a **recorded machine baseline**: CPU model,
  core count, RAM, OS/kernel version, filesystem, build profile, and whether the
  index/cache was warm.
- Budgets are stated as p50/p95 with a sample count and a defined workload.
- A budget is reported as *met*, *missed*, or **unmeasured**. *Unmeasured* may not be
  reported as *met*.
- A budget is never met by weakening a security control. If a budget and a control
  conflict, **the control wins** and the budget is renegotiated with recorded evidence.

**Budgets.** Values marked *(provisional)* are targets to be replaced by a measured
baseline before the corresponding release gate closes; they are stated so the shape of
the budget is agreed now, not so a number can be quoted as fact.

| Budget | Target | Workload definition |
|---|---|---|
| Startup to interactive prompt, warm cache | p50 ≤ 250 ms, p95 ≤ 600 ms *(provisional)* | Release build, warm index and catalog cache, synthetic 200-file repo, no network |
| Cold start with no network (curated primary catalog only, no enrichment cache) | p50 ≤ 700 ms *(provisional)* | Same, release build, catalog enrichment disabled, no network |
| ACP `initialize` → ready | within the warm startup bound | Release build over a pipe |
| Render | full-frame redraw p95 ≤ 16 ms; a 100k-line transcript redraw touches only visible rows + the mutable tail | Synthetic transcript; the live region is virtualized (`REQ-PERF-002`) |
| Tool-output capture and bounding | decision p95 ≤ 20 ms for a 50 MiB streamed capture | Bounded stream, spill path exercised |
| Repo-map incremental rebuild | p95 ≤ 250 ms for a ≤50-file delta, never on the loop path (`REQ-PERF-003`) | Warm index, 50 changed files |
| `audit verify` | ≤ 2 s per 100k entries, full chain | Synthetic chain on local disk |
| Session replay | ≥ 10k events/s, single-threaded | Synthetic log |
| Memory ceiling | A stated per-Thread and per-subsystem ceiling, asserted in a soak run | 8-hour soak with a bounded workload |

### Release gates

A release is blocked unless **all** of these pass and their records are retained.
Gate IDs are `G-1..G-16` (no leading zero). `ARCH/22`'s threat table also uses a `G-`
prefix with zero padding (`G-01..G-10`); cite those rows as `ARCH/22` `G-0N`.

| Gate | Requirement |
|---|---|
| `G-1` | License allowlist check passes; every `Adapt`/`Vendor` entry has a complete in-tree provenance record (`DEC-012`, `ARCH/05` §4) |
| `G-2` | `THIRD-PARTY-NOTICES` is generated from the resolved dependency graph and shipped with the binary (`DEC-011`, `AX-010`) |
| `G-3` | Full suite green with zero quarantined tests across ≥5 consecutive runs; the determinism-sensitive suites across ≥20 repetitions |
| `G-4` | Containment acceptance (`ACC-P1-01`) passes for **every** supported tier, with a record per tier, and each record **names that tier's `network_guarantee_level`**, its mechanism, and its residual (`DEC-026`); a tier claiming a stronger level than it proves fails |
| `G-5` | `audit verify`, class census, and per-effect ID reconciliation pass on a fresh run and a crash-injection run; the record stores the actual anchoring level and rendered claim boundary (`REQ-AUDIT-001/005/007`, `DEC-031`). An unknown effect or unreachable required anchor blocks release. |
| `G-6` | The headless exit-code contract matches `--help` (`ACC-P1-08`) |
| `G-7` | The session-format and artifact migration chains round-trip exact event/blob references, recover interruption from the authoritative source generation, and refuse a newer stored version |
| `G-8` | Performance budgets are measured with a recorded baseline, or an unmeasured budget is explicitly disclosed and is **not** a P1 exit criterion |
| `G-9` | Product copy makes no unsupported peer comparison; factual provider/model names and required attribution are accurate and provenance-linked (`REQ-VISION-003`, `DEC-011`, `DEC-030`). |
| `G-10` | Fuzz corpus is clean for the current cycle, with no new crash/unbounded-allocation finding |
| `G-11` | Every eval-gated feature that ships has a runnable gate **at the time it shipped** (`DEC-016`); the paired-eval report is retained |
| `G-12` | Every `REQ-*` in a shipped capability has a traceability row naming its evidence, or is explicitly marked unimplemented |
| `G-13` | A long-horizon completion claim has `ACC-H1-01..10` evidence at the exact integrated revision and current specification; worker completion, an isolated-worktree pass, or a PR URL alone does not pass. |
| `G-14` | Every shipped worker/control surface satisfies `REQ-SEC-026` with process-level evidence for its declared backend: a worker cannot invoke control operations, read/write canonical state, mint an operator receipt, or supply caller-authored actor/scope to controller methods; raw ACP identity is not trusted. A backend or adapter without such evidence refuses that execution profile. |
| `G-15` | Session artifacts pass `ACC-P1-09`, segmented event logs pass `ACC-P1-11`, and integrated durability passes `ACC-P1-13` on every supported persistence backend before the product claims durable sessions/runs; `ACC-P1-13A` is the independently runnable primitive gate and is not blocked on `ACC-P1-11`/`13`. `ACC-P1-12` proves read-only inspection cannot mutate or hide canonical history failures. Output truncation passes `ACC-P1-10` for every route that advertises automatic remaining-context recovery. Unknown route semantics remain non-retrying and are not counted as supported recovery. |
| `G-16` | The session-search feature cannot be called shipped/available until `ACC-P1-14` passes at the exact integrated revision; if FTS5 or complete index coverage is unavailable, the UI/CLI reports a typed unavailable/partial result and never claims complete search. |

### Long-horizon acceptance matrix (required before a multi-hour-autonomy claim)

| ID | Scenario and required observation | Evidence |
|---|---|---|
| `ACC-H1-01` | `/goal set` persists the original request only and performs no model/repository/tool/peer work. Explicit bounded `/goal prepare` produces a revision-pinned read-only proposal; clarification changes its digest. TUI/CLI/ACP start requires user approval of the currently displayed spec, task-graph, plan, base, route, permission, and budget digests through an authenticated operator control session. ACP agent-server approval uses negotiated agent-to-client form elicitation or the exact one-use typed fallback only for a configured trusted interactive connector; raw ACP connection/session binding is not authentication or proof a person saw the review. ACP peer elicitation when HorizonCode is acting as a client never approves its run. Generic “yes”, tool permission, worker output, stale preview, open blocking question, duplicate delivery, disconnect, or session mismatch dispatches no code work. A worker cannot approve its own interpretation. Clearing the selected goal pointer does not change a paused run's durable lifecycle; after restart the run remains resumable by ID. | Original/preparation request digests and budgets, read-only boundary trace, spec versions, per-surface approval receipt and authentication context, stale-start and replay traces, cancellation/decline evidence, invalidation graph, pointer event/projection replay, resume trace, and verifier verdicts. |
| `ACC-H1-02` | Kill the controller before effect, after effect but before receipt, during external PR creation, and during task settlement. Recovery fences old workers, reconciles effects, and never duplicates a non-idempotent operation or marks an unknown outcome passed. | Repeated kill matrix, effect-ID joins, remote/worktree observations and audit receipts. |
| `ACC-H1-03` | Concurrent ready tasks cannot overspend the run ceiling; each dispatch reserves verification and recovery. Retry counters and costs survive restart, model switch and ACP reconnect; exhausted budget ends as `STOPPED`, never `COMPLETED`. | Reservation ledger and repeated concurrent schedule traces. |
| `ACC-H1-04` | A peer disconnect, unsupported resume, hidden nested agents, and missing cost data retain explicit unknowns; HorizonCode can still inspect diff and verify an exact integrated commit. A stale lease cannot write. | Capability snapshots, external attempt timeline, fence failures and integrated test record. |
| `ACC-H1-05` | A multi-hour task passes only after independent spec and intent scenarios, regression checks and combined-worktree tests at the final commit. A deliberately wrong but internally consistent spec is rejected or returns `INSUFFICIENT_EVIDENCE`. | Same-model/same-budget baseline report with raw failures, exact commits, cost/time, and acceptance artifacts. |
| `ACC-H1-06` | A same-host TUI client detaches while work continues under a supervised controller; the same OS user reattaches through the restricted local control socket with snapshot plus ordered events. Per-Thread tool-call start/progress/result events retain sequence and call identity; a result never precedes or attaches to the wrong start. A cursor gap resnapshots, a host/controller stop shows last-confirmed time, and neither disconnect nor display reconnect duplicates a worker or effect. Slow subscribers and overflow cannot block cancellation/permission lanes; overflow is explicit and recovery uses the durable cursor. This row does not claim remote SSH attachment or multi-user server isolation. | Client/cursor trace, event sequence and replay digest, per-call correlation trace, injected slow-subscriber/overflow schedules, control-lane latency, process/lease observations, and exact effect IDs. |
| `ACC-H1-07` | Start review persists a challenge before display and binds the canonical review digest, policy/permission/budget and other approved digests, principal, run/goal, authenticated session/connection, delivery IDs, and expiry. Same-payload retries return the same challenge; changed-payload replay conflicts. Replacing a preview, material state change, extra input, disconnect before response, expiry, or cross-session response invalidates it. Two concurrent review surfaces cannot confirm different plans. Kill/restart between accepted response, reservation, activation event, projection update, outbox claim, process launch, and launch receipt: no work launches before `GoalActivated`; durable reservations never double-spend; a policy/budget revision change at commit fails compare-and-swap; expired accepted receipt cannot activate. Race `/cancel` against activation in both serialized orders: before activation it fences the commit and reaches `CANCELLED` only after reservation release; after activation it fences run dispatch and reconciles in-flight effects. After activation, replay uses the same event/outbox/attempt IDs; unknown launch remains blocked until reconciled. | Challenge/event/projection digests, two-client race traces, invalidation and replay outcomes, policy/budget revision race traces, cancellation/activation order traces, reservation-release ledger evidence, process/supervisor observations, outbox/attempt ID joins, and no-duplicate-run evidence. |
| `ACC-H1-08` | Exercise `/cancel run`, `/cancel task`, and `/cancel attempt` with matching and mismatched scopes, missing/foreign IDs, inconsistent task/attempt ancestry, reused delivery IDs, and completion-vs-cancel races. A run cancel fences every new claim; a task cancel fences only that task, leaves independent work eligible, and records dependent tasks as blocked without cascading cancellation; an attempt cancel affects only its attempt and retries only when policy/budget/attempt limits allow. Unknown child/process/effect state remains `RECONCILING`; only observed terminal/reconciled work can become `CANCELLED`; a completed target remains unchanged and returns `ALREADY_TERMINAL`. Also test natural-language cancellation with omitted/ambiguous target, `/stop-now` separation, restart during reconciliation, and duplicate same-payload versus changed-payload replay. | Target/ancestry authorization traces, cancellation event and fence order, queue eligibility and dependency projections, child/supervisor/effect receipts, idempotency/replay evidence, restart recovery trace, and final task/run state. |
| `ACC-H1-09` | Run an artifact-backed multi-hour task with original request, user image/input, large tool output, partial provider response, test report, and verifier evidence. Kill/restart around object write, digest publication, owner-event append, run pin, projection update, migration switch, export/import, and GC. Rebuild owner refs from canonical logs; preserve exact bytes across compaction/restart/workspace move; prove active writers/readers/pins fence GC; incomplete owner enumeration deletes nothing; tampered/missing artifacts become typed unavailable and dependent tasks remain `INSUFFICIENT_EVIDENCE`; storage exhaustion stops or waits without silently dropping history; a complete retained export remains independently verifiable. | Same-run source/destination manifest and event hashes, kill/recovery traces, artifact-owner graph and lease epochs, GC mark set/zero-delete failure record, byte-limit/quota ledger, verifier-state transitions, and final integrated-revision evidence. |
| `ACC-H1-10` | Run a multi-hour workload whose event volume forces repeated segment rotation while UI clients detach/reattach and context compacts. Replay/index rebuild memory stays within the declared batch budget; event order and committed head remain exact. Drive event-log quota and real ENOSPC to the boundary: the protected control/recovery file was physically allocated before activation and remains usable, dispatch fences before it is consumed, in-flight effects reconcile, cancellation/stop/handoff remain durably recordable, status distinguishes `WAITING`/`STOPPED` from completion, and no canonical event is pruned. Resume only after approved capacity/policy revalidation; a corrupted/missing committed segment blocks completion. | Multi-hour event-rate/segment counts, RSS and replay-latency traces, storage reservation ledger and physical allocation receipts, detach cursor replay proof, ENOSPC/fault matrix, retained event hashes and exact final integrated revision. |

### Interactive coding and editor acceptance (required before a fast-coding claim)

These records are proposed gates, not evidence that the UI or workflows exist. Run
them against the exact supported platform/editor/provider combinations; preserve the
test artifacts and report unsupported combinations explicitly.

| ID | What is proven | Evidence required |
|---|---|---|
| `ACC-UX-01` | A natural-language direct turn can explain/locate, make a focused edit, repair a failing check, add a modest feature, inspect a diff, and respond to a correction without first creating a goal, preparing a plan, or accepting a Run review. Chat/Explore and Plan mode restrictions hold; switching modes does not claim universal cache reuse. | Paired task results on pinned repository commits and pinned product/model/config versions; exact final diff/check evidence; task success/regressions; first useful action/token, local overhead, approvals, interventions, calls, duration, reported/unknown usage and uncertainty. |
| `ACC-UX-02` | Routine workspace coding permissions are predictable and do not repeatedly prompt for the same still-valid exact grant; hard-deny, catastrophic, external reach, and required confinement remain effective. | Decision/prompt traces over explain, edit, build, debug and external/destructive cases; principal/resource/action/scope/expiry/grant identity; proof no project text, hook, mode or reduced-approval setting widens hard gates. |
| `ACC-EDITOR-01` | Configured editor handoff works for the declared terminal-wait, GUI-wait, and GUI-detach profiles. Waiting handoff restores terminal state and fresh dimensions after resize; detached save refreshes the Explorer/diff and an operator-edit lock prevents a conflicting agent write until resolved. | OS/editor/version/config matrix including VS Code, Vim/Neovim, Zed, Helix and generic configured editors; launch argv receipts, terminal mode/size traces, save/hash and lock traces, failure cleanup, and documented unsupported profiles. |
| `ACC-EDIT-02` | Stale-base reconciliation never overwrites concurrent work: exact-base changes can be applied only after a deterministic non-overlapping merge and compare-and-swap; ambiguity/overlap requires review. CRLF/LF normalization assists alignment without changing raw-byte authority or discarding meaningful whitespace. Turn Diff and Total Working Diff are distinct; no auto-stage/commit occurs. | Raw and normalized digest records, clean/conflicting/ambiguous merge fixtures, CAS races, whitespace/line-ending cases, before/after worktree and index snapshots, and no changes to commit/ref/reflog state. |
| `ACC-UX-03` | Direct-turn Escape/Ctrl-C cancellation fences late results and terminates supervised child process trees within the platform's declared grace/force policy; ordinary turns have visible bounded resource ceilings and can be explicitly continued. Quick checks are relevant and bounded. | Provider stream/tool/process race traces; descendant-process census on supported OSes; ceiling/continue outcomes including unknown provider usage; no orphan process after terminal cancellation; checks prove failures are fed back and retries stop at the configured cap. |
| `ACC-UX-04` | Direct-thread compaction preserves active intent, user corrections, decisions, evidence and unresolved questions while retaining the configured verbatim tail; it does not resurrect superseded requests or require managed-Run checkpoint headings. | Adversarial long-chat corpus, blinded intent/correction recall rubric, before/after prompt projection, source-event links, and failure cases where missing/ambiguous facts remain explicit. |
| `ACC-UX-05` | Shell profiles run through the same guard, sandbox and audit path on each advertised platform; noninteractive commands use bounded pipes by default and PTY use is explicit. Hook definitions are reviewed/trusted by digest, environment is scrubbed, and timeout/crash/malformed output cannot grant effects. | Bash, PowerShell, cmd, zsh and fish coverage where advertised; PTY/non-PTY and process/FD/handle pressure cases; hook source-change, trust, malformed JSON, timeout, output-limit, environment and deny traces. |
| `ACC-UX-06` | One user intent invoked through each available button, palette entry, slash command, and shortcut reaches the same typed action/controller result and permission path. Composer suggestions preserve draft/focus until explicit commit; `@file:` insertion does not open a file and Explorer selection does. The default Tasks list represents requested tasks as primary rows, while IDs/attempts/Threads/executions/evidence remain inspectable in detail; background completion causes no navigation/focus theft. Session browsing supports search/pagination and explicit resume/delete actions with confirmation; diff navigation returns to chat, and rollback previews affected files without claiming external-effect reversal. Extensions' `/extensions`, `/connectors`/`/apps`, `/mcp`, `/skill`, `/plugin`, `/hooks`, `/workflows`, and `/marketplace` entries all route to one surface/category-aware action and preserve composer/layout state. The default Installed view presents item/type/state/primary action and reveals detailed provenance/configuration in detail or staged review. The full layout remains Explorer/chat/Tasks and narrow mode restores its previous geometry. | Scripted TUI interaction matrix for each action entry, action/effect/Guard receipt comparison, draft and focus snapshots, file-reference vs file-open traces, task row/detail model checks, background completion and reconnect races, session coverage/resume/delete-confirmation traces, diff-to-chat return, rollback preview/cancel/confirm, each shared Extensions route/category, extension default/detail states, resize/focus/layout restore, keyboard/pointer/accessibility captures, and stale suggestion/scanner cancellation traces. |
| `ACC-REPO-01` | Lexical, syntax-graph and optional local semantic retrieval return useful, revision-correct results; semantic indexing is off by default and any remote embedding route clearly discloses data egress before use. | Natural-language retrieval benchmark including “where is X validated?” queries, exact-symbol/error/path queries, stale-index fallback, local/remote provider route disclosure, opt-in/off behavior and relevance/regression statistics. |
| `ACC-PROV-SYNC-01` | Full parity passes only when every connector/auth path in the pinned OpenCode/Cline matrices has a HorizonCode-owned, authorized route and passes conformance; any blocker makes full parity fail and stays visible. Upstream changes produce a reviewable candidate with provenance/license checks and cannot alter installed code or active routes until a reviewed signed release is installed. | Complete pinned connector/auth matrix, source drift report, per-file license/notice review, candidate diff/fixtures, route conformance for every connector, release signature/install evidence, and proof runtime performs no remote code loading. |
| `ACC-ANALYTICS-01` | Ordinary direct-turn usage is attributed to Thread/Turn without fabricated Run/Task/Attempt IDs; cache read and cache write/creation remain distinct or explicitly unknown. | Ledger rows and rebuild proof across direct/managed turns, nullable-ID schema checks, duplicate/replay behavior, and provider-reported versus estimated/unknown usage cases. |
| `ACC-DIAG-01` | `hzcode doctor` and `/doctor` use the same versioned report schema and finding rules; surface-specific facts and probe coverage remain explicit. Startup warnings that link to Doctor resolve to the same finding ID. Local report mode performs no network/provider call or mutation; unknown/unavailable/unsupported/not-checked/error evidence stays explicit; secret canaries are absent; configured sandbox policy is not reported as proven enforcement. A repair ID outside the finite registry is rejected. For a registered repair, stale facts/targets, preview decline, auth failure, symlink/out-of-root target, audit-prepare failure, and write failure cause no unauthorized change; accepted repair uses the owning service, emits its durable prepare and single terminal audit receipt, creates the required backup, and passes a postcondition check. | Exact CLI/TUI revision and platform; JSON schema and human/JSON parity fixtures; startup finding-ID parity; network and filesystem effect trace; secret-canary report; stale-plan and cancellation cases; Guard challenge/receipt, exact preview, prepare/terminal audit receipt, backup/atomic-write evidence, postcondition, and refusal trace. |
| `ACC-SKILL-01` | Built-in/skill and skill/skill name collisions preserve every skill through stable source-qualified invocation; the built-in retains its bare command, qualified-name collisions fail explicitly, and `/skill` remains manager navigation. Invocation rejects changed source identity/digest. Guided `/create-skill` (and Skills → Create) validates scope/name/frontmatter, previews the exact manifest, refuses overwrite, preserves a cancelled draft without writes, and does not auto-enable or execute scripts. | Registry fixtures with built-in, repo/user/plugin duplicate names and reordered discovery; help/completion provenance; stale digest and malformed-source refusal; wizard keyboard/headless, preview/decline/cancel, project/user path containment, symlink/overwrite, audit/Guard, and no activation/script execution effect traces. |
| `ACC-TOOL-DISCOVERY-01` | Large catalogs return bounded metadata-only search results; exact-ID and natural-language queries find expected candidates. Only selected, currently permitted tool schemas are materialized within budget and pinned with registration/catalog/schema/permission snapshots for the model step. Guessed, unselected, changed, removed, or newly denied tools fail typed before execution; refresh cannot mutate the active step. | Synthetic large MCP/tool catalog with measured candidate and schema byte/token bounds; exact and natural-language relevance fixtures; permission-denial and malicious-metadata cases; catalog/schema/permission changes between search, materialization, and dispatch; registry/effect trace proving zero execution during discovery and refusal before execution on stale selection. |
| `ACC-MARKET-01` | A dated catalog snapshot proves at least 500 unique, source-resolvable entries for broad release and reports progress toward 1,000 by family/source. Counting excludes aliases/mirrors, versions, provider offers, and bundled components unless separately published. Search is bounded and metadata-only; source identity, lifecycle status, compatibility and trust evidence remain distinct; deleted/stale/upstream failures are visible. | Frozen source fixtures plus exact dated synchronized snapshot/count manifest; duplicate/conflict and source-deletion/update replay; pagination/incremental cursor restart, throttling, malformed/oversized manifest, stale/error states, source URL/redirect policy and no-payload-fetch trace; count invariants for bundles/providers/versions; compatibility/trust badge evidence freshness. A fixture proves adapter behavior only; the ≥500 catalog claim requires a real dated source snapshot with resolved source references. |
| `ACC-CONNECTION-01` | A Connector's service identity, provider offer, account Connection, capability, and permission grant remain separate. Multiple accounts/providers can be configured without token sharing across products; disconnect revokes the product-local credential reference and grants but does not uninstall package data. Active work uses pinned provider/Connection/grant/tool schemas and policy epoch. | Multiple account/provider fixtures; no-token serialization, logs, UI, or cross-product import; secret reference resolution/revocation; Guard action matrix for read/write/external-send/destructive operations; disconnect/reconnect and package-uninstall independence; active Run snapshot remains unchanged across credential/catalog refresh; staged OAuth/MCP failures and headless pending-auth status. |
| `ACC-REPO-LSP-01` | One repository-intelligence owner provides read-only definition, reference, hover, diagnostics, document/workspace-symbol, implementation, and call-hierarchy operations. Results carry observed revision/freshness; external paths remain guarded; missing, stale, unsupported, or crashed LSP produces typed status and labeled lexical/tree-sitter fallback. | LSP protocol fixtures for each operation; path-boundary and no-write traces; changed-file/revision and stale-index races; server absent/crash/unsupported/malformed responses; fallback visibility and source revision/digest checks; proof that only the shared repo-intelligence/LSP owner is used. |

### Definition of done

A capability is done when **all** of the following hold. A capability that fails any
line is **implemented but unverified** and MUST be labeled as such wherever it
appears.

1. The design document for the owning `CMP-*` exists and cites the `REQ-*` ids.
2. The implementation exists on the single governed path (no second engine, registry,
   scheduler, or permission system).
3. L1 and L2 tests exist, including every **deny** and **refuse** branch and at least
   one fail-closed test per interface.
4. L3 integration coverage exercises the governed path for every declared
   security-relevant effect class the capability can produce.
5. If user-visible, it is driven from outside the binary at least once at L4.
6. If it makes a **readiness** claim, an L5 acceptance record exists for the claiming
   platform/tier.
7. Failure modes listed in the component document have tests, not just the happy path.
8. A performance budget is measured, or explicitly recorded as unmeasured.
9. The `REQ-*` has a traceability row and its open questions are closed or explicitly
   deferred with an owner.
10. Residual risks are either mitigated or in the register (`ARCH/22` §Residual-risk
    register) with a treatment and a review date.

### Where evidence is produced and retained

```
<state-dir>/evidence/<build-id>/
  suites/            # per-layer test reports, repeat counts, quarantine list
  acceptance/
    sandbox/<tier>/  # ACC-P1-01 records + raw output + kernel/runtime versions
    guard/            # ACC-P1-02 decision-table report
    acp/              # ACC-P1-03 / ACC-P1-05 transcripts + method-coverage diff
    audit/            # ACC-P1-04 verify output, tamper report, census, anchor receipt
    session/          # ACC-P1-06 golden hashes + restart matrix
    context/          # ACC-P1-07 probe results per strategy version
    headless/         # ACC-P1-08 exit-code matrix + --help snapshot
  perf/              # baselines: machine description, raw samples, computed p50/p95
  fuzz/              # corpus + last run summary + committed crashers
```

- **Build id** is a content hash of the built artifact plus the exact commit, so a
  record cannot be attributed to the wrong build.
- **Retention:** full records are CI build artifacts attached to the build, retained
  for the release window. They are not committed to the repository (size and
  reproducibility concerns).
- **Committed** to the repository: golden corpora, the guard decision table, the
  compaction probe set, fuzz corpora, random seeds, and a small **acceptance index**
  mapping each `REQ-*` to the record that covers it.
- **A record is evidence only for the build id, platform, and tier it names.** It may
  never be presented as evidence for another build or another platform.

## Responsibilities

**Owned by this document's process (no single component owns it):**

- The layer definitions and their exit criteria.
- The acceptance matrix and its pass criteria.
- The determinism/flake/quarantine policy.
- The performance budget table and its measurement discipline.
- The release gate list and the definition of done.
- The evidence artifact layout, naming, and retention rules.

**Explicitly not owned:**

- Any effect or policy decision — this release-verification process observes and
  never grants authority. It is distinct from the **runtime task verifier** in
  `ARCH/25`, which the controller invokes before a task may enter `PASSED`.
  The runtime verifier records evidence but does not itself execute an unguarded
  effect or decide policy.
- Test implementation details per component; those live with the component.
- The compression and routing evaluation methodology (`ARCH/19`, `ARCH/09` §5,
  `ARCH/11`), which this document requires to be run and recorded.
- Product acceptance criteria, which belong to `ARCH/01-VISION.md` and `ARCH/06-UI.md`.

## Interfaces

| Component | Verification seam |
|---|---|
| `CMP-runner` | Turn/step state machine, terminal-state contract, cancellation, fail-unsettled, step bound |
| `CMP-session` | Event-log append/replay/repair, checkpoints, fork boundary, migration chain, per-key coordinator |
| `CMP-context` | Assembly order, budget arithmetic, compaction trigger and continuity, prefix stability, epoch |
| `CMP-tools` | Schema decode/encode, materialization filtering, bounded output, the model/UI split, and the **extraction** of path-shaped shell arguments into `fs.*` resources — the seam asserts extraction only, never a path decision (`DEC-024`, `REQ-SEC-025`) |
| `CMP-provider` | **Mock transport seam**; adapter conformance fixtures; retry single-ownership; usage accounting; egress denial typing |
| `CMP-guard` | Decision table, tickets, approval lifecycle, modes, saved-rule exactness, the external-directory floor rule, the load-time rejection of a path-shaped `exec.run` resource, and the static gate that no other component evaluates path policy |
| `CMP-sandbox` | `probe` seam (for backend-absence tests), `check_path`/`spawn` as the only enforcement calls, per-tier read scoping, profile immutability, violation records, and the declared `network_guarantee_level` per tier |
| `CMP-audit` | Chain math, verify, census, anchoring, redaction, cross-store reconciliation |
| `CMP-orch` | Authority intersection, bounds, receipts, leases, deterministic merge |
| `CMP-acp` | **Scripted stdio client harness** for L4; capability gating; schema conformance |
| `CMP-mcp` | Loopback MCP servers (stdio child and streamable HTTP), pagination cap, dedupe, auth failure typing |
| `CMP-extension-catalog` | Source-adapter fixtures, bounded/incremental sync, canonical dedupe/conflict handling, metadata-only search, stale/deleted state, and per-host compatibility evidence; the real catalog target uses a dated source snapshot |
| `CMP-config` | Layer merge, schema rejection, project-scope narrowing only, secret-reference enforcement |
| `CMP-analytics` | Ledger/rollup rebuild, observed-vs-estimated, export sanitization |
| `CMP-tui` / `CMP-headless` | Layout stability (no shift on commit), truthful status, `NO_COLOR`/`TERM=dumb`/reduced-motion, exit codes |

## Data / state model

```
EvidenceRecord  = { build_id, commit, layer, suite, verdict, duration_ms,
                    environment{os, kernel, tier, backend}, repetitions }
Verdict         = pass | fail | unmeasured | skipped_blocked
AcceptanceRecord= { build_id, platform, tier, backend, sub_checks[{id, verdict,
                    evidence_ref}], operator_surface, notes,
                    network_guarantee_level, network_mechanism, network_residual,
                    anchor_level, anchor_claim_rendered }
Budget          = { id, p50, p95, samples, workload, machine_baseline, verdict }
Quarantine      = { test_id, owner, reason, issue_ref, expires_on }
TraceabilityRow = { req, owner_doc, code_paths, decision_refs, task_id,
                    evidence_ref, status }
Status          = proposed | implemented | verified | accepted | blocked
```

`verdict = unmeasured` is a first-class value. It is never rendered as `pass`, and a
requirement whose only evidence is `unmeasured` is `implemented`, never `accepted`.

## Flows

### 1. From requirement to evidence

```
REQ-*  →  design (ARCH/NN) cites it
       →  implementation on the governed path
       →  L1/L2 tests (deny + refuse + fail-closed branches)
       →  L3 governed-path integration per effect class
       →  L4 outside-the-binary drive (if user-visible)
       →  L5 acceptance record (if a readiness claim is made)
       →  traceability row updated
       →  release gates evaluated
```

A step that cannot be performed is recorded as `skipped_blocked` **with a reason**,
never silently omitted. A `skipped_blocked` acceptance row blocks the exit criterion
it belongs to.

### 2. Producing a containment record

1. Build in release mode; record build id and commit.
2. Create a temp workspace with a deny-glob tree and a `protected` path.
3. Apply the requested profile; record the resolved profile, the backend, and the
   tier's **declared `network_guarantee_level`** with its mechanism and residual.
4. For each sub-check: attempt the escape, record the observed OS-level outcome and the
   specific mechanism evidence, and record whether the violation was audited.
5. Repeat with the backend made unavailable via the `probe` seam → expect deny + audit.
6. Write the record with the platform, kernel/runtime versions, and every sub-check
   verdict. A missing sub-check is a failure, not an omission.

### 3. A flake is found

1. The repeat run fails; the failing seed/input is preserved immediately.
2. The test is **not** quarantined silently. Either it is fixed, or a quarantine entry
   is created with owner, reason, issue, and expiry.
3. If the flake is in a security-relevant test, the release gate is blocked until it
   is fixed.
4. The owning requirement's status is downgraded, because a flaking test has not
   demonstrated determinism.

### 4. Claim hygiene

Any place that shows a capability's status (TUI panel, headless status, docs table,
release notes) reads the traceability row. It may render `verified` only from a
revision-bound verification record, and `accepted`, `ready`, `contained`, or `audited`
only from the applicable accepted record. An `implemented` row must retain that
weaker label even when its unit tests pass; it cannot be promoted by a worker claim.
Otherwise the surface shows the weaker, true word.

## Failure modes

| Failure | Behavior |
|---|---|
| A test depends on a real clock, network, or machine state | The test is invalid; it is rewritten against the injected substrate, not retried until green |
| A golden file changes without a reviewed reason | The change is rejected; regenerating goldens in the same change as the behavior change is a review finding |
| A sub-check is skipped for lack of privilege or platform | Recorded as `skipped_blocked` with a reason; blocks its exit criterion |
| A mock diverges from the real transport | The adapter conformance fixture set is regenerated from the wire format and the mock corrected; the divergence is recorded with a date |
| An acceptance run happens on the wrong tier or build | The record is void (its own fields say so) and the gate is re-run |
| A benchmark runs on a loaded machine and is recorded as a baseline | The baseline is invalid; baselines record machine state and are re-taken on a quiet machine |
| Evidence is attached to the wrong build id | The record names its own build id and cannot be cited elsewhere |
| A unit test is cited as acceptance evidence | A traceability-status finding; the requirement drops to `implemented` |
| A quarantine exists at release time | Release blocked if any quarantined test is security-relevant; otherwise the quarantine list ships with the release notes |
| The configured anchor sink is unreachable | The gate fails; it never degrades to a local-only run presented as anchored (`DEC-022`) |
| The record names a network level stronger than the tier proves | The row fails; the level, its mechanism, and the residual are rewritten to what was observed, or the tier is refused the profile it cannot confine (`DEC-026`) |
| `verify` renders `local-sink` as `off-box`, or omits the claim boundary | `ACC-P1-04` fails; the rendered evidence is the artifact under test, so a weaker level presented as stronger is a failure, not a wording nit (`REQ-AUDIT-007`) |
| A path decision is produced outside the guard | The static architecture gate fails the build (`DEC-025`, `REQ-SEC-025`) |
| Fuzzing finds a crash or unbounded allocation | Release blocker; the minimized input is committed as a regression case |
| An eval-gated feature ships before its harness can run | Release blocked (`DEC-016`) |

## Configuration

Proposed verification key group (schema-versioned, discovered global → project, and
**project scope may only tighten** — it may not reduce repetitions, disable a layer, or
skip an acceptance row). This group is not yet in `ARCH/18`; see Open questions.

| Key | Meaning | Default |
|---|---|---|
| `verification.layers` | enabled layers | `unit, contract, integration, e2e` |
| `verification.repeat` | full-suite consecutive clean runs required on the merge gate | `5` |
| `verification.repeat_determinism` | repetitions for process/platform-sensitive suites | `20` |
| `verification.timeout_ms.default` | per-test default timeout | `60000` |
| `verification.golden_dir` | committed golden corpus location | repo-relative |
| `verification.evidence_dir` | local evidence root | `<state-dir>/evidence` |
| `verification.perf.baseline` | recorded machine baseline descriptor | required for a budget to be `measured` |
| `verification.quarantine` | per-test quarantine entries with owner + expiry | none permitted for security-relevant tests |
| `verification.fuzz.corpora` | committed corpora roots | repo-relative |
| `verification.anchor_required` | fail the gate when the configured audit anchor is unreachable | `true` |

## Requirements mapping

`REQ-VER-001..018` are added by this document. Discharging map: `REQ-VER-005..011` are
discharged by the **P1 acceptance matrix** (`ACC-P1-01..21`) — the matrix is not the
whole verification strategy; `REQ-VER-001/015/017` by the **layering, anti-claims, and
definition of done**; `REQ-VER-002/003` by the **determinism substrate and transport
rules**; `REQ-VER-004/016` by the **repeat/quarantine policy and fuzz coverage**;
`REQ-VER-012` by the **performance budget discipline**; `REQ-VER-013/014` by the
**release gates and evidence retention**.

| REQ | Where satisfied |
|---|---|
| `REQ-VER-001` | §Strategy layers + exit criteria; `implemented but unverified` labeling rule |
| `REQ-VER-002` | §Determinism — injectable substrate table |
| `REQ-VER-003` | §Determinism — transport rules (mock provider transports, loopback only) |
| `REQ-VER-004` | §Determinism — repeat and quarantine policy |
| `REQ-VER-005` | `ACC-P1-01` — the network sub-check asserts each tier's **declared** guarantee level rather than one universal no-network claim, and the record stores `network_guarantee_level` / `network_mechanism` / `network_residual` (`DEC-026`, `DEC-027`) |
| `REQ-VER-006` | `ACC-P1-02` |
| `REQ-VER-007` | `ACC-P1-03` |
| `REQ-VER-008` | `ACC-P1-04` |
| `REQ-VER-009` | `ACC-P1-06` |
| `REQ-VER-010` | `ACC-P1-07` |
| `REQ-VER-011` | `ACC-P1-08` |
| `REQ-VER-012` | §Performance budgets — measurement discipline (`unmeasured` is a verdict) |
| `REQ-VER-013` | §Release gates `G-1..G-16` |
| `REQ-VER-014` | §Where evidence is produced and retained — build id, platform, tier binding |
| `REQ-VER-015` | §Anti-claims + §Claim hygiene |
| `REQ-VER-016` | §Adversarial-input coverage |
| `REQ-VER-017` | §Definition of done line 3 + the failure-mode table (a fix without a regression test is not done) |
| `REQ-VER-018` | §Release gates `G-11`; generalizes `DEC-016`'s sequencing rule — see Open question 5 |
| `REQ-CTX-003`, `REQ-CTX-008`, `REQ-CTX-009` | `ACC-P1-07` exact code/tool observation preservation and retrieval probe + paired A/B; `G-11` |
| `REQ-CTX-002`, `REQ-CTX-004` | `ACC-P1-07`: route-window threshold, summary-model fit, independent hard guard, exhaustive `auto=false`, and bounded pre-content recovery |
| `REQ-CTX-011` | `ACC-P1-10`: typed cause, exact-once eligible recovery, preserved partial artifact/usage and route conformance |
| `REQ-PROV-005` | Routing eval-gate evidence is a P2 forward-declared item and a `G-11` obligation |
| `REQ-PROV-009`, `REQ-PROV-010` | `ACC-PROV-OC-GO` live Go-connector acceptance plus the per-route conformance records any advertised route requires; provider inventory completeness and terms/client-registration states remain visible and unusable until proven |
| `REQ-PROV-012`, `REQ-PROV-013`, `REQ-PROV-015`, `REQ-ANALYTICS-002` | `ACC-P1-18` pinned fallback/retry, exposure boundary, separate dispatch accounting, safe body replay, bounded backoff and preserved terminal error; `ACC-P1-10` partial/absent usage accounting and conservative unknown projection |
| `REQ-TOOL-007` | `ACC-P1-19` model-facing retrieval from compacted Thread history |
| `REQ-CTX-007`, `REQ-PROV-008` | `ACC-P1-20` route-specific system-prompt update semantics and safe replacement default |
| `REQ-GUARD-006` | `ACC-P1-21` principal/connection-bound approval challenge, disconnect/expiry/cancel invalidation, current-revision and effect-boundary digest revalidation |
| `REQ-AUDIT-002`, `REQ-AUDIT-005` | `ACC-P1-04`; `G-5` |
| `REQ-AUDIT-004` | `ACC-P1-04` anchor receipt; `G-5` (an unreachable anchor fails) |
| `REQ-AUDIT-007` | `ACC-P1-04` stores the anchoring level and captures the rendered claim boundary; `G-5` (`DEC-022`) |
| `REQ-AUDIT-008` | `ACC-P1-04` actor/scope/destination authorization and independent access receipt before disclosure |
| `REQ-AUDIT-009` | `ACC-P1-04` global/per-segment sequence, read-only checks, explicit preservation-based repair |
| `REQ-AUDIT-010` | `ACC-P1-04` cross-process append barrier, unique contiguous sequence and root verification |
| `REQ-AUDIT-011` | `ACC-P1-04` typed malformed/missing/inaccessible/incomplete-store failure matrix |
| `REQ-GUARD-004` | `ACC-P1-01(d)` per the tier's **declared** network guarantee level; `ACC-P1-01(j)` is the refusal half; `G-4` (`DEC-026`, `DEC-027`) |
| `REQ-SEC-016`, `REQ-SEC-008` | `ACC-P1-01(d)`/`(j)` for the extension-profile level and for a network grant no content can create (`DEC-027`) |
| `REQ-SEC-003`, `REQ-SEC-025` | `ACC-P1-01` (reach) and `ACC-P1-02` (authorization + the static "no path evaluation outside the guard" gate) (`DEC-024`, `DEC-025`) |
| `REQ-SEC-026` | Process-level worker/control/approval-origin tests in `ACC-H1-01` and release gate `G-14`; no backend support claim without evidence |
| `REQ-SESS-002` | `ACC-P1-06` |
| `REQ-SESS-005` | `ACC-P1-09`: immutable blobs, bounded ingestion/decoding, migration, typed unavailability and complete-mark GC |
| `REQ-SESS-006` | `ACC-P1-06`, `ACC-P1-11..13`: integrity, bounded replay, finite capacity, byte-preserving reads, visible enumeration failures, and platform durability; `ACC-P1-13A` independently verifies only the reusable durability primitive |
| `REQ-SESS-007` | `ACC-P1-14` plus `G-16`: reference-scan parity, complete/typed coverage, privacy, exact message identity and non-mutating search |
| `REQ-SESS-008` | `ACC-P1-15`: unique stable Thread identity, separated execution and external session bindings, independent task/thread graphs, byte-preserving crash-safe migration, and evidence-only task completion |
| `REQ-ORCH-010` + `REQ-TOOL-006` | `ACC-P1-16`: durable exact-origin question request/answer, whole-batch question arbitration, safe pause/resume, idempotent delivery, negotiated adapter support, no authority escalation |
| `REQ-ORCH-011` | `ACC-P1-17`: bind asynchronous conclusions to input/spec/graph/policy/workspace revisions and revalidate before commit or dispatch |
| `REQ-UI-021` | `ACC-P1-16` plus `research docs/tests.md`: selectable/accessible forms, draft/pane preservation, explicit answer receipt and headless pending-input rendering |
| `REQ-UI-017` | `ACC-P1-14`, `G-16`, and the interactive search cases in `research docs/tests.md`: query scope/filter UX, full-history navigation, title-only result handling, composer preservation and coverage visibility |
| `REQ-HORIZON-026` | `ACC-P1-09` for service integrity and `ACC-H1-09` for run/evidence ownership, crash recovery, quota stops and GC races |
| `REQ-HORIZON-027` | `ACC-P1-11` for bounded segment/replay/storage behavior and `ACC-H1-10` for multi-hour run pressure and recovery |
| `REQ-PROTO-001`, `REQ-PROTO-002`, `REQ-PROTO-006` | `ACC-P1-03`, `ACC-P1-05` |
| `REQ-PERF-001`, `REQ-PERF-002`, `REQ-PERF-003` | §Performance budgets |
| `REQ-UI-002`, `REQ-UI-003`, `REQ-UI-004`, `REQ-UI-008` | `CMP-tui` seam; L4 scripted-session rows |
| `REQ-VISION-005`, `REQ-UI-028` | `ACC-UX-01`: direct coding starts from natural language without goal/plan/Run review; mode restrictions and paired quick-task outcomes |
| `REQ-UI-029` | `ACC-DIAG-01`: common offline typed diagnostics report, truthful unknowns and enforcement evidence, and finite authenticated/audited repair flow |
| `REQ-UI-030` | `ACC-UX-06`: equivalent action/controller/Guard path across interactive entry points, draft-preserving suggestions, task-first list with detailed identities, progressive Extensions, and no focus theft |
| `REQ-UI-020` | `ACC-UX-06`: Connectors/MCP/Skills/Plugins/hooks/workflows/marketplace command entry points route to their category in one surface with draft/layout preservation and no implicit effect |
| `REQ-SKILL-005` | `ACC-SKILL-01`: collision-safe source-qualified skill invocation, digest recheck, and guarded non-activating creation wizard |
| `REQ-CTX-010` | `ACC-TOOL-DISCOVERY-01`: bounded metadata search, permission-filtered selected schemas, per-step pinning, and stale-call refusal |
| `REQ-PLUGIN-005` | `ACC-MARKET-01`: source-resolvable catalog count and dedup invariants, metadata-only bounded search, and separate listing/compatibility/trust claims |
| `REQ-PLUGIN-006` | `ACC-CONNECTION-01`: distinct service/provider/account/grant records, product-local secrets, lifecycle, and active-work snapshot pinning |
| `REQ-CTX-012` | `ACC-REPO-LSP-01`: one revision-aware LSP/repository-intelligence owner with labeled fallback |
| `REQ-GUARD-007` | `ACC-UX-02`: prompt friction and exact-grant scope/expiry alongside hard-deny and confinement regression cases |
| `REQ-UI-005`, `REQ-UI-023`, `REQ-UI-026` | `ACC-EDITOR-01`: configured native editor profiles, wait/detach lifecycle, terminal resize/restore, save refresh and operator lock |
| `REQ-UI-024`, `REQ-SEC-028`, `REQ-SEC-030` | `ACC-EDIT-02`: turn/total diff distinction, raw-digest CAS, deterministic concurrent-edit reconciliation, and unchanged Git index/refs |
| `REQ-UI-025`, `REQ-UI-027` | `ACC-UX-05`: progressive human-readable status, exact inspector, bounded command-output summaries, and lossless durable event retrieval |
| `REQ-LOOP-010..012` | `ACC-UX-03`: per-turn bounded resources, cancellation/late-result fencing, process-tree cleanup, and bounded relevant checks |
| `REQ-CTX-013` | `ACC-UX-04`: direct-thread compaction fidelity and no lost/resurrected intent |
| `REQ-CTX-014` | `ACC-REPO-01`: lexical/syntax/optional-local semantic relevance, opt-in, stale fallback and egress disclosure |
| `REQ-TOOL-008..009`, `REQ-SEC-029` | `ACC-UX-05`: shell profiles, PTY semantics, process/handle limits, hook trust/protocol/environment and fail-closed authority |
| `REQ-PROV-016` | `ACC-PROV-SYNC-01`: complete pinned OpenCode/Cline matrix, route conformance, license-reviewed update candidate and signed release boundary |
| `REQ-ANALYTICS-009` | `ACC-ANALYTICS-01`: Thread/Turn direct usage, nullable Run IDs, separate cache-read/write fields and unknown usage preservation |
| `REQ-VISION-003` | `G-9` |
| `REQ-SEC-001` | `G-1`, `G-2` |

## Open questions

1. **Where the acceptance index is committed.** The small traceability index belongs in
   the repository; its location, format, and update discipline (manual vs.
   generated-from-tests) are undecided, and generated-from-tests is attractive because
   it cannot drift.
2. **Evidence retention window.** "The release window" is not a number. How long full
   records are kept per platform/tier, and whether a superseded record is archived or
   deleted, needs a decision.
3. **`ACC-P1-01` on the remote/container tiers.** Container and micro-VM tiers are in
   the `SandboxProvider` abstraction; whether they get their own acceptance rows
   (beyond "the same suite runs against each tier that advertises support") is
   undecided.
4. **The compaction probe set's owner and threshold.** Who curates the pre-registered
   "must remain retrievable" facts, and what regression margin blocks a strategy
   change? `ARCH/09` Open question 5 raises the same item from the design side.
5. **Generalizing `DEC-016`'s sequencing rule.** `DEC-016` fixes "harness before
   gated feature" for compression. This document applies it to every eval-gated
   feature (routing included) as `G-11`. Making that a hard decision rather than a
   documentation practice requires a `DEC-*`; it is flagged, not assumed.
6. **The `verification.*` configuration group.** Proposed here but not yet part of
   `ARCH/18`'s key groups. It should be added there (with schema version and
   migration) or explicitly kept out of user configuration and made internal.
7. **TUI acceptance.** A scripted TUI session is the only way to prove
   `REQ-UI-003` (zero layout shift) and the accessibility properties. Whether that
   harness is in scope for P1 or lands with the cockpit in P2 is undecided; the
   `CMP-tui` seam is listed either way.
8. **macOS network-restricted profiles as an acceptance row.** Seatbelt source emits a
   network rule, but the platform row is not accepted until macOS host tests establish
   actual destinations, child inheritance, local IPC, and helper-process behavior. Keep
   the currently reported level/residual conservative and refuse any stronger required
   level (`DEC-037`, `ACC-P1-01`).
9. **Adversarial corpus sourcing.** Fuzz corpora and the injection corpus are ours to
   generate. Whether a curated public corpus is also used (and how its provenance is
   recorded) is undecided.
10. **Budget baselines per platform.** Budgets are stated for one unspecified machine
    shape. Whether the baseline is normalized (per-core, or expressed as a ratio to a
    reference step) so one number serves all supported platforms is undecided.
11. **Coverage measurement for L1/L2.** Branch coverage is a useful signal but not a
    proof of behavior. Whether a coverage floor is a merge gate, and which toolchain
    computes it deterministically across platforms, is undecided.
12. **Determinism of the harness itself.** A test harness that leaks state between
    tests (shared caches, global registries, a shared temp root) undermines every
    claim above. Whether an explicit per-test isolation assertion (fresh state dir, no
    inherited handles) is required at L1 is undecided.
