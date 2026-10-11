# 37 — Runtime service interfaces, registry aliases and acceptance contracts

**Status:** normative V1 LLD target, not code-implemented or platform-tested. Read with §§17, 20, 25, 29–33, 36.
**Owners:** OpenCode Core for canonical session/provider/consumer state; Rust for effect/managed work/resource authorization. All external adapters are non-authoritative.

## 37.1 Common contract vocabulary

All service operations carry a versioned RequestContext with caller principal, workspace/root policy refs, selected agent/model/harness/toolset generations, trace/correlation/request IDs, cancellation/deadline, and immutable authority scope. Replies carry observed generation, provenance, bounded result ref, ordered error detail and measured/unknown timings.

Any state change has an idempotency key or explicit non-retryable marking. Mutating requests also carry expected revision/fence; duplicate same-key/same-digest returns same receipt; same key/different digest is CONFLICT. UNKNOWN is not failure or success. Cancellation is a REQUEST; provider/process/remote effects require reconciliation before a terminal claim. Neither human-readable text nor a model result can grant permissions.

Common typed error codes: INVALID_ARGUMENT, UNSUPPORTED_CAPABILITY, POLICY_DENIED, APPROVAL_REQUIRED, UNTRUSTED_SOURCE, NOT_FOUND, STALE_GENERATION, STALE_REVISION, CONFLICT, CANCEL_REQUESTED, DEADLINE_EXCEEDED, BACKPRESSURE, TRANSPORT_LOST, UNKNOWN_EFFECT, RATE_LIMITED, QUOTA_EXHAUSTED, INTERNAL_FAILURE. Error is explicit, structured, never an implicit empty successful response.

## 37.2 Governed registry, stable IDs and source of truth

Canonical stable namespaces:
- Agents: builtin.build / builtin.plan / builtin.explorer / builtin.architect / builtin.librarian / builtin.looker / builtin.reviewer / builtin.test-debugger / builtin.system-operator / builtin.browser-qa / builtin.history-search / builtin.verifier.
- Skills: builtin.horizon-docs and other §33 built-ins. A project/user/plugin skill may have the same display name but never replace a sealed ID by filesystem precedence.
- Jobs: job.title.generate and other §33 deterministic or small-model maintenance jobs.
- Tools: exact §33 dot-style canonical IDs, including files.patch, terminal.run, agents.spawn, symbols.search, repo.impact, browser.navigate, dom.query, context.compact and automations.create.
- Actions: typed user-facing ActionDescriptor with stable actionId; commands, slash aliases, palette, shortcut and buttons all resolve to one action target, not a second handler.

Machine-readable *seed* at contracts-v2/capability-registry-v1.json lists canonical IDs plus compatibility aliases; it is not a full runtime registry or proof of a wired tool. Canonical resolution:
1. classify input source (model tool, user command, plugin, MCP, SDK);
2. resolve normalized name and caller-scoped generation; unknown/ambiguous alias → INVALID_ARGUMENT, sealed collision → POLICY_DENIED;
3. resolve versioned canonical ID and exact input schema; pin profile/harness/toolset/policy generation at start of model turn;
4. derive effect class from canonical target, not alias/source description;
5. intersect agent policy, parent scope, project policy, OS resource policy and requested effect;
6. recheck expected input/workspace revision, call Guard and lease for effects; no legacy direct execution;
7. return one canonical observation and alias provenance. A registry reload affects only later turns.

Legacy fs.*, exec.*, agent.*, repo.symbol and alternate action names are compatibility spellings. Never let them register a privileged handler, reinterpret path globs or bypass the ordinary effect flow. Alias chaining and cycles are prohibited; every alias resolves exactly once to a canonical ID. §33 is normative for target naming.

## 37.3 Browser/DOM normalized backend (proposed, not implemented)

Source placement: app/browser integration seam in packages/app/desktop and existing OpenCode browser tool support, with effect mediation through Rust; do not create a new standalone browser process manager before source audit.

Interface BrowserBackendV1:
- capabilities(sessionRef): protocol/version, installed driver, headless support, screenshot/DOM/a11y/network/console flags, limitations and enforced isolation;
- createContext(profile, originPolicy, lease, requestId): contextRef and immutable origin/cookie profile generation;
- navigate(contextRef, URL, expectedNavigationGeneration, deadline): navigation generation + bounded load evidence;
- snapshot(contextRef, kind DOM|A11Y, maxNodes, redaction): SnapshotRef with origin, generation, hash, bounded handles;
- query(snapshotRef, locator, maxMatches): element handles tied to snapshot/origin generation and confidence;
- interact(contextRef, elementRef, action click|type|select|scroll, arguments, effectContext): EffectReceipt plus invalidation of stale element handles;
- screenshot(contextRef, viewport, redaction): bounded artifact metadata/ref (never raw base64 in prompts);
- diagnostics(contextRef, sinceCursor): bounded console/network errors and status;
- assert(contextRef, predicate): source-bound test observation; closeContext(contextRef, expectedGeneration): ownership-verified cleanup.

Failures: BROWSER_NOT_INSTALLED, ORIGIN_DENIED, SESSION_EXPIRED, ELEMENT_STALE, SELECTOR_AMBIGUOUS, DOM_UNAVAILABLE, NAVIGATION_ABORTED, DRIVER_CRASH, UNKNOWN_EFFECT. Page text is untrusted data, not a command or permission. Browser tool and MCP browser routes resolve to this normalized contract and Guard; third-party opaque automation must declare weaker assurance. Stale handles NEVER silently rebind to a different element.

Acceptance: §32 BR-001..010, SA-015/016, PS-009/010; navigation/click through Guard; malicious page injection; crash/reconnect; no network permission escalation.

## 37.4 LanguageServiceBroker (proposed; existing OpenCode LSP to reuse)

Source placement: adapt packages/opencode/src/lsp or actual registered editor Core seam; existing indexd/src is lexical partial only. No duplicate project language server by default.

Interface LanguageServiceBrokerV1:
- discover(workspace, language, scope): sorted snapshots source editor|supervised|external with root, interpreter/toolchain/config digest, generation, health, capabilities and visibility;
- attach(snapshotId, expectedGeneration): read-only or permitted adapter handle; never take ownership of editor process;
- ensureSupervised(language, root, configDigest, capabilityNeeds, effectContext): reuse existing owned server or request Guard-backed process launch;
- definition(handle, URI, location, revision): candidates with exact source/confidence/generation;
- references(handle, symbolRef, limit,cursor): bounded result and next cursor;
- outline(handle, URI,revision): AST/symbol ranges; diagnostics(handle, URI, sourceRevision): diagnostics with origin and version;
- applyCodeAction(handle, command, revision, effectContext): MUTATING ToolIntent even if named query;
- release(handle): no stop of editor-owned server; stopSupervised only with owning lease.

Failures: LSP_UNAVAILABLE, ROOT_CONFIG_MISMATCH, SERVER_STALE, RESULT_STALE, SERVER_FAILED, POLICY_DENIED. Root/config/interpreter changes invalidate generations. Fallback parser/index/lexical is explicit with lower confidence; never report lexical guesses as LSP proof. Server stderr is bounded/artifactized. Test §32 LS-001..004 and read-only shell/LSP/MCP mutation denial.

## 37.5 DelegationMailbox and child lifecycle (proposed Rust-managed control + Core agent adapters)

Interface DelegationMailboxV1:
- estimate(parentExecutionId, taskPackage, proposedProfile): overhead/conflict/cost estimate (no child created);
- admit(parentExecutionId, immutable task package, profile revision, expectedOwnerEpoch, idempotencyKey): child reservation/fence or policy/limit error;
- spawn(admissionId, ownerEpoch, resourceLease): worker binding, launch receipt and exact state (PREPARED/LAUNCHING/RUNNING/UNKNOWN);
- send(parentId, childId, typed ArtifactRef, messageId, bounded TTL): durable delivery receipt and cursor, never arbitrary authority;
- receive(childId, cursor, maxMessages): ordered bounded messages with acknowledgements and gap/resnapshot;
- reply(childId, requestId, resultRef/evidenceRefs/status): immutable completion proposal; parent Task PASS requires VerificationService;
- cancel(childId, requestId): terminal only after process state reconciled;
- status(childId): current lifecycle, lease, unknown/blocked reason.

Limits: max nesting/fanout, child messages/bytes, context/tokens/tool calls, time and worktree/resource leases. Inter-agent text is untrusted data. Parent denies always dominate child profile allows. Parallel tasks with shared files/ports/DBs serialize or isolate, never race unmediated. Retry after crash creates new Attempt/Worker binding, not duplicate effect.

Errors: CHILD_NOT_ALLOWED, DELEGATION_DEPTH_EXCEEDED, RESOURCE_CONFLICT, BUDGET_EXCEEDED, MAILBOX_FULL, CHILD_UNKNOWN, RESULT_STALE, CANCEL_RACE. Acceptance §32 SA-001..016, AG-013/014, GS-002..008, CX-010.

## 37.6 AutomationService (proposed durable Rust owner plus typed ActionDescriptor)

Interface AutomationServiceV2:
- list(scope, cursor, limit), inspect(id), previewSchedule(expression, timezone, DSTPolicy, horizon), create(draft, idempotencyKey), update(id, expectedRevision, patch), enable/disable(id, expectedRevision), nextRuns(id,count), runNow(id, expectedRevision, causeId), trigger(id, cause), cancelRun(runId, requestId), history(id,cursor,limit), remove(id,expectedRevision).
- Each scheduled invocation pins action/schema/agent/profile/model/budget/permission revision. Scheduler creates an ordinary ActionDescriptor invocation; NEVER calls effectful target tool directly.
- Misfires: skip or run_once; overlap: skip / queue_one / queue_all (with explicit bounded queue cap). Deduplicate by automation ID + schedule occurrence identity, not wall clock alone. DST gap/repeated-time policy is explicit, previewable and tested. Disabled while running prevents future starts but does not rewrite an already-authorized effect.
- Recursion prevention uses correlation lineage, max nested trigger depth, cooldown and dedup key.
- Failed host/offline provider → BLOCKED with exact reason, not hidden paid fallback.

Errors: BAD_CRON, TIMEZONE_UNKNOWN, AMBIGUOUS_LOCAL_TIME, QUEUE_FULL, ALREADY_TRIGGERED, ACTION_UNAVAILABLE, APPROVAL_REQUIRED, RUN_UNKNOWN. Tests §32 AU-001..008 plus DST double-run, same-event reentry, crash/restart exactly-once admission (NOT exactly-once remote effects).

## 37.7 UiEventMux (proposed projection/transport, not authority)

Interface UiEventMuxV2:
- subscribe(scope, afterDurableCursor?, maxQueueBytes, supportedKinds): subscription ID, snapshot revision, durable cursor, bounded async event stream;
- ack(subscriptionId, contiguousDurableCursor): update per-subscription ack; reject future/other-stream/stale-epoch cursor;
- resnapshot(subscriptionId, scope, expectedEpoch?): immutable snapshot + cursor or typed retention loss;
- unsubscribe(subscriptionId), heartbeat(subscriptionId), status(subscriptionId).

Durable semantic events: message boundaries, tool/effect status, approvals, Task/Run, artifact refs, verification/usage checkpoints. Ephemeral text deltas/progress/terminal repaints may coalesce/drop under bounded memory. Durable events cannot silently drop or reorder. On gap/retention loss UI must resnapshot and dedup message ID/event ID. Slow tabs cannot backpressure canonical writer indefinitely. A completed message is retrieved from OpenCode canonical state, not reconstructed solely from missing transient deltas. Never expose raw provider secrets/private reasoning without explicit separate allowed disclosure.

Errors: CURSOR_MISMATCH, CURSOR_FUTURE, EVENT_GAP, RETENTION_EXPIRED, SUBSCRIPTION_CLOSED, BACKPRESSURE, SNAPSHOT_STALE. Tests §32 UI-001..015, PF-001..005, retransmission/no duplicate final message, 1/4/16 thread interleaving, viewer focus isolation.

## 37.8 Artifact/Mermaid and terminal graphics capability (proposed)

Interface ArtifactRenderServiceV2:
- inspect(ref), chooseRenderer(mediaType, surfaceCapabilities, trust), render(ref, rendererId, sourceDigest, theme, constraints, cancellation), export(ref, format, effectContext), cacheLookup(renderKey), invalidate(rendererVersion).
- Isolate generated untrusted Mermaid, SVG, HTML and document parsers in supervised bounded workers/subprocesses; limit bytes, nodes, depth, dimensions, CPU/wall memory/network. No inherited secrets or untrusted external resource fetch.
- Render completed Mermaid fence only; streaming shows code/fallback. Cache by source digest + renderer version + theme + sizing, not source path. Worker crashes/timeouts produce source+diagnostic and reap owned resources.
- Terminal capability order: detect exact terminal graphics protocols (for example supported image escape features), validate probe; if rendering supported show isolated raster artifact; else use text diagram renderer if reliable; else syntax-highlighted Mermaid source with open/copy action. Never silently emit graphics escape bytes to unknown terminals.
- Generated artifact reference must be content-addressed, size-bounded and revision-linked. Terminal/viewer can retrieve bounded ranges instead of full model context injection.

Errors: RENDERER_UNAVAILABLE, UNSUPPORTED_SURFACE, UNSAFE_CONTENT, TOO_LARGE, RENDER_TIMEOUT, RENDER_CRASH, ARTIFACT_STALE. Tests UI-008..010, PF-002, malformed graph injection, 10K-node limit, terminal no-graphics fallback.

## 37.9 CacheObservationAdapter and local-model telemetry (proposed)

Interface CacheObservationAdapterV1:
- probe(providerId,modelId,protocolVersion): supported cache write/read usage fields, boundary semantics, token counting availability, pricing version;
- planSegments(contextPlan, route, cacheCapabilities): stable static/history/attachment/turn segment digests; never guarantee cache hit;
- observe(providerResponse, requestId, routeVersion): reported cacheRead/cacheWrite/requestInput tokens with provenance measured|estimated|unknown; preserve raw bucket relationships to avoid double-count;
- reconcile(observationId, providerReport): idempotent correction without silently turning unknown into zero;
- calculateCost(usage, pinnedPricePolicy): measured or estimated with currency/source/time, or UNKNOWN; no fabricated zero dollar value.
- The provider/endpoint selection is unchanged; unsupported caching silently remains disabled or unknown, not a request to switch providers. Server-specific cache headers/breakpoints cannot leak secret/PII.
- Cold local inference model load/queue/TTFT are distinct spans; not every long TTFT means endpoint failure.

Failures: CACHE_UNSUPPORTED, USAGE_NOT_REPORTED, PRICE_UNKNOWN, PROVIDER_METRIC_CONFLICT; these usually affect diagnostics, not task execution. Tests §32 AN-001..010, LM-011, CX-007 and dual-vendor cross-check.

## 37.10 Contract adoption and release gate

For each service: assign a real source module and one owner in §09/§24 BEFORE coding; pin version/schema, test successful path, malformed input, unauthorized effect, process crash, cancellation race, stale revision, duplicate delivery, restart/replay and resource cleanup. Source paths described as PROPOSED remain NOT IMPLEMENTED until actual files/tests prove otherwise.

Schema files under contracts-v2 cover wire shape only. Runtime must use generated/adapted validators and real TS/Rust fixtures rather than trusting Markdown pseudotypes or parse-only checks. §32 provides model-independent task tests. §36 defines sequence. No claim that the services described here are shipped.

## 37.11 Verification evidence and limits (2026-10-11)

Run python3 scripts/architecture/run_contract_tests.py for design-schema validation followed by the **existing, real** Bun Session-to-Rust projection and Rust authenticated RPC tests. Last manual source-bound tests on 2026-10-11: 5 Bun tests, 52 assertions, pass; 2 Rust tests, pass. Those tests do not validate the newly proposed Browser/LSP/Delegation/Automation/Mermaid/Cache services. Add generated TS/Rust binding validation, shared malformed/cross-process fixtures, security/timeout/replay tests before any new service is WIRED/VERIFIED.

## 37.12 Pinned OMP visual-streaming research gap notes (proposed)

[§41](41-OMP-STREAMING-VISUAL-ARTIFACTS-AUDIT.md) supplies source code and test evidence candidates for UiEventMuxV2 and ArtifactRenderServiceV2. Proposed additions only: FigureBlockV1 source-digest/revision/open-final semantics, IncrementalSvgRenderer V1 cancellation/stale-raster fencing and text fallbacks, deterministic complete-table ChartSpecV1 and optional explicitly billed smart model use, terminal per-surface image lease/transmit-once/purge rules, artifact receipt FULL/SAMPLE fidelity, and terminal history acknowledgment distinct from durable Core/Guard receipt. OMP provider event queues explicitly lack hard backpressure; Horizon must bound the presentation lane without losing canonical events. No runtime interfaces, adoption or release status changed.

## 37.13 Pinned-source extraction and adapter admission (2026-10-11)

Each runtime service proposed in this document MUST be tied to [source provenance §42](42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md) SRC item, current real code path, schema ID, generated TS/Rust types, effect admission, scope, per-platform supports flags, cancellation/rollback vs UNKNOWN, source revision, and negative tests defined in [source-to-LLD §43](43-IMPLEMENTATION-SOURCE-LLD-PLAYBOOK.md)/[converged implementation plan](../docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md). UX/visual behavior adoption A-V2-22/23 authorizes design/testing priority, NOT automatic execution or copy. New scoped FigureBlock, ModelCatalog, SecretBroker provider account and SourceArtifact FULL/SAMPLE shapes remain design-only until implemented.
